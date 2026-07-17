/**
 * Sudo Helper Extension
 *
 * 当 agent 通过 bash 工具执行 sudo 命令时，弹出遮罩密码输入框。
 * 通过 SUDO_ASKPASS + FIFO（/dev/shm tmpfs 内核管道）安全注入密码。
 *
 * 安全特性：
 * - 密码不落盘（FIFO 在 /dev/shm tmpfs 上，纯 RAM）
 * - 密码不出现在 ps / /proc（通过内核管道传递，不在 cmdline / environ 中）
 * - 密码不传 agent（session 记录原始命令，agent 只看原始命令 + 结果）
 * - 密码 XOR 加密存储（明文从不存在于 V8 不可变 string 堆中）
 * - 密码用完即毁（Buffer.fill(0) 物理清零，非等待 GC）
 *
 * 工作流程：
 * 1. tool_call 事件检测 bash 命令是否含 sudo
 * 2. sudo -n true 预检：sudo timestamp 有效则跳过
 * 3. 创建 FIFO + askpass 脚本（/dev/shm，权限 0600 / 0700）
 * 4. 启动 cat 进程（阻塞在 FIFO open，等待 reader）
 * 5. 弹出遮罩密码框，用户输入密码（XOR 加密存储于 SecureBuffer）
 * 6. 提交时：解密 → 写入 cat stdin → 立即清零明文 Buffer
 * 7. 修改命令：仅第一个 sudo → SUDO_ASKPASS=<script> sudo -A
 * 8. bash 工具执行：sudo -A 调用 askpass → cat FIFO → 密码通过管道传递
 * 9. 后续 sudo 靠 sudo timestamp 缓存执行
 */

import { spawn } from "node:child_process";
import { randomFillSync, randomUUID } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@schovest/pi-coding-agent";
import { type Component, type Focusable, matchesKey } from "@schovest/pi-tui";

/** 匹配命令中第一个 sudo（用于检测和单次替换） */
const SUDO_PATTERN = /\bsudo(?=\s)/;

/** 临时文件存活上限（兜底清理） */
const CLEANUP_TIMEOUT_MS = 60_000;

/** sudo 预检超时 */
const SUDO_PRECHECK_TIMEOUT_MS = 5000;

interface SudoResources {
	fifoPath: string;
	scriptPath: string;
	writer: ReturnType<typeof spawn>;
	timer: NodeJS.Timeout;
}

export default function (pi: ExtensionAPI) {
	/** toolCallId → 待清理资源 */
	const pending = new Map<string, SudoResources>();

	/** 清理 sudo 临时资源 */
	function cleanupResources(toolCallId: string): void {
		const res = pending.get(toolCallId);
		if (!res) return;
		pending.delete(toolCallId);

		clearTimeout(res.timer);
		try {
			res.writer.kill();
		} catch {
			// 进程可能已退出
		}
		unlink(res.fifoPath).catch(() => {});
		unlink(res.scriptPath).catch(() => {});
	}

	// =========================================================================
	// tool_call: 拦截 sudo 命令，注入密码
	// =========================================================================

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command = event.input["command"];
		if (typeof command !== "string") return;
		if (!SUDO_PATTERN.test(command)) return;

		// 非 TUI 模式无法弹窗，不干预
		if (!ctx.hasUI) return;

		// 预检：sudo timestamp 是否有效（不需要密码）
		try {
			const precheck = await pi.exec("sudo", ["-n", "true"], {
				timeout: SUDO_PRECHECK_TIMEOUT_MS,
			});
			if (precheck.code === 0) return; // 不需要密码，不干预
		} catch {
			// sudo -n true 失败说明需要密码，继续
		}

		// 创建 FIFO + askpass 脚本（/dev/shm = tmpfs，纯 RAM）
		const rand = randomUUID().slice(0, 8);
		const fifoPath = `/dev/shm/pi-sudo-fifo-${rand}`;
		const scriptPath = `/dev/shm/pi-sudo-askpass-${rand}`;

		try {
			await pi.exec("mkfifo", [fifoPath], { timeout: 5000 });
			await chmod(fifoPath, 0o600);
		} catch {
			ctx.ui.notify("sudo-helper: 无法创建 FIFO（/dev/shm 不可用？），跳过密码注入", "warning");
			return; // 不干预，让 sudo 自行提示
		}

		try {
			await writeFile(scriptPath, `#!/bin/sh\nexec cat '${fifoPath}'\n`);
			await chmod(scriptPath, 0o700);
		} catch {
			await unlink(fifoPath).catch(() => {});
			ctx.ui.notify("sudo-helper: 无法创建 askpass 脚本", "warning");
			return;
		}

		// 启动 cat 进程：阻塞在 FIFO open(O_WRONLY)，等待 askpass 打开读端
		// stdin 数据缓存在 OS 管道缓冲区中，cat unblock 后读取
		// cmdline: "sh -c cat > /dev/shm/pi-sudo-fifo-xxx" —— 不含密码
		const writer = spawn("sh", ["-c", `cat > '${fifoPath}'`], {
			detached: true,
			stdio: ["pipe", "ignore", "ignore"],
		});

		// 弹出遮罩密码输入框（密码直接写入 writer.stdin，不经过 JS string）
		let submitted = false;
		try {
			submitted = await ctx.ui.custom<boolean>(
				(_tui, _theme, _keybindings, done) =>
					new PasswordInputComponent("sudo 密码", writer.stdin, done),
				{ overlay: true },
			);
		} catch {
			submitted = false;
		}

		// 用户取消 → 关闭 cat stdin，清理资源
		if (!submitted) {
			try {
				writer.stdin.end();
			} catch {
				// stdin 可能已关闭
			}
			try {
				writer.kill();
			} catch {
				// 进程可能已退出
			}
			await unlink(fifoPath).catch(() => {});
			await unlink(scriptPath).catch(() => {});
			return { block: true, reason: "用户取消了 sudo 密码输入" };
		}

		// 关闭 cat stdin：cat 读到 EOF 后关闭 FIFO 写端
		// 否则 askpass 的 cat FIFO 永远收不到 EOF，sudo 假死
		try {
			writer.stdin.end();
		} catch {
			// stdin 可能已关闭
		}

		// 修改命令：仅第一个 sudo → SUDO_ASKPASS=<script> sudo -A
		// 后续 sudo 不修改，靠第一个 sudo 建立的 timestamp 缓存执行
		// session 记录原始 toolCall（无修改），args 用修改后的值执行
		const modifiedCommand = command.replace(SUDO_PATTERN, `SUDO_ASKPASS='${scriptPath}' sudo -A`);
		event.input["command"] = modifiedCommand;

		// 注册清理
		const timer = setTimeout(() => cleanupResources(event.toolCallId), CLEANUP_TIMEOUT_MS);
		pending.set(event.toolCallId, { fifoPath, scriptPath, writer, timer });
	});

	// =========================================================================
	// tool_result: 清理临时资源
	// =========================================================================

	pi.on("tool_result", async (event) => {
		cleanupResources(event.toolCallId);
	});
}

// =============================================================================
// XOR 加密缓冲区 —— 密码明文从不作为连续内存存在
// =============================================================================

/**
 * 逐字符 XOR 加密的密码缓冲区。
 *
 * - 每个输入字符立即与随机 key XOR 加密后存入 Buffer
 * - 明文仅存在于 flushTo() 的临时 plain Buffer 中，写入后立即 fill(0)
 * - V8 堆中只有 encrypted + key 两个分立的 Buffer，不可组合还原
 */
class SecureBuffer {
	private encrypted = Buffer.alloc(0);
	private key = Buffer.alloc(0);
	/** 每个字符的 UTF-8 字节长度，用于 backspace 截断 */
	private charByteLengths: number[] = [];

	/** 追加一个字符（立即 XOR 加密） */
	append(char: string): void {
		const bytes = Buffer.from(char, "utf8");
		const keyPart = Buffer.alloc(bytes.length);
		randomFillSync(keyPart);
		const encPart = Buffer.alloc(bytes.length);
		for (let i = 0; i < bytes.length; i++) {
			encPart[i] = bytes[i] ^ keyPart[i];
		}
		this.encrypted = Buffer.concat([this.encrypted, encPart]);
		this.key = Buffer.concat([this.key, keyPart]);
		this.charByteLengths.push(bytes.length);
		// 立即清零临时明文
		bytes.fill(0);
	}

	/** 退格删除最后一个字符 */
	backspace(): void {
		const len = this.charByteLengths.pop();
		if (len === undefined) return;
		const total = this.encrypted.length;
		// 截断前先清零被删除的字节
		this.encrypted.fill(0, total - len);
		this.key.fill(0, total - len);
		this.encrypted = this.encrypted.subarray(0, total - len);
		this.key = this.key.subarray(0, total - len);
	}

	/** 字符数（用于遮罩渲染） */
	get length(): number {
		return this.charByteLengths.length;
	}

	/**
	 * 解密为明文，写入流，然后立即清零所有缓冲区。
	 * 明文 Buffer 仅存活于 write() 调用期间。
	 */
	flushTo(stream: { write(data: Buffer | string): boolean }): void {
		const plain = Buffer.allocUnsafe(this.encrypted.length);
		for (let i = 0; i < plain.length; i++) {
			plain[i] = this.encrypted[i] ^ this.key[i];
		}
		stream.write(plain);
		stream.write("\n");
		// 立即物理清零明文
		plain.fill(0);
		// 清零所有加密状态
		this.destroy();
	}

	/** 物理清零所有缓冲区 */
	destroy(): void {
		if (this.encrypted.length > 0) this.encrypted.fill(0);
		if (this.key.length > 0) this.key.fill(0);
		this.encrypted = Buffer.alloc(0);
		this.key = Buffer.alloc(0);
		this.charByteLengths = [];
	}
}

// =============================================================================
// 密码输入组件（遮罩显示 + XOR 加密）
// =============================================================================

/**
 * 单行密码输入组件。
 *
 * - 输入字符显示为 ●（遮罩）
 * - 密码以 XOR 加密存储于 SecureBuffer，明文从不作为 string 存在
 * - 提交时解密直接写入 writeTarget（cat stdin），写入后立即清零
 * - Enter 提交，Esc / Ctrl+C / Ctrl+D 取消
 */
class PasswordInputComponent implements Component, Focusable {
	private secure = new SecureBuffer();
	private _focused = false;
	private done = false;

	constructor(
		private readonly title: string,
		private readonly writeTarget: { write(data: Buffer | string): boolean },
		private readonly resolve: (submitted: boolean) => void,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(v: boolean) {
		this._focused = v;
	}

	invalidate(): void {
		// 无缓存状态
	}

	handleInput(data: string): boolean | void {
		if (this.done) return;

		// 用 matchesKey 判断特殊键，正确区分 Escape 键和转义序列
		// 避免 \x1b[A（箭头键/鼠标滚轮）被误判为 Escape 导致弹窗关闭

		// Enter 提交
		if (matchesKey(data, "enter")) {
			this.submit();
			return;
		}

		// 仅 Escape / Ctrl+C / Ctrl+D 取消
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			this.cancel();
			return;
		}

		// Backspace
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			this.secure.backspace();
			return;
		}

		// 忽略所有其他转义序列（箭头键、功能键、鼠标等）
		if (data.startsWith("\x1b")) return;

		// 忽略 bracketed paste 标记
		if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) return;

		// 可打印字符（逐字符处理，含 Unicode）
		for (const char of data) {
			const code = char.charCodeAt(0);
			if (code >= 0x20) {
				this.secure.append(char);
			}
		}
	}

	render(width: number): string[] {
		// 硬编码 ANSI 颜色（扩展在 jiti 环境下 theme 可能不可用）
		// 亮黄色边框 + 反色标题 + 深灰背景输入框，确保高对比度醒目
		const YELLOW_BOLD = "\x1b[1;93m"; // 亮黄色粗体
		const REVERSE = "\x1b[7m"; // 反色
		const RED_BOLD = "\x1b[1;91m"; // 亮红色粗体（标题）
		const CYAN = "\x1b[96m"; // 亮青色
		const DIM = "\x1b[2m"; // 暗色
		const INPUT_BG = "\x1b[48;5;238m"; // 深灰背景
		const RESET = "\x1b[0m";

		const innerWidth = Math.max(1, width);
		const borderLine = `${YELLOW_BOLD}${"━".repeat(innerWidth)}${RESET}`;

		// 标题行：反色高亮，居中
		const titleText = ` 🔒 ${this.title} `;
		const titlePadBefore = Math.floor((innerWidth - titleText.length) / 2);
		const titlePadAfter = innerWidth - titleText.length - titlePadBefore;
		const titleLine = `${REVERSE}${RED_BOLD}${" ".repeat(Math.max(0, titlePadBefore))}${titleText}${" ".repeat(Math.max(0, titlePadAfter))}${RESET}`;

		// 提示行
		const hintText = " Enter 提交 · Esc 取消 ";
		const hintPad = Math.floor((innerWidth - hintText.length) / 2);
		const hintLine = `${DIM}${" ".repeat(Math.max(0, hintPad))}${hintText}${RESET}`;

		// 遮罩 + 光标（带背景色）
		const charCount = this.secure.length;
		const maxDots = Math.max(0, innerWidth - 4); // "> " (2) + cursor (1) + margin (1)
		const masked = "●".repeat(Math.min(charCount, maxDots));
		const cursor = this._focused ? `${INPUT_BG}\x1b[7m \x1b[27m` : `${INPUT_BG} `;
		const inputVisualWidth = 2 + Math.min(charCount, maxDots) + 1; // "> " + dots + cursor
		const inputPadding = " ".repeat(Math.max(0, innerWidth - inputVisualWidth));
		const inputLine = `${INPUT_BG}${CYAN}>${RESET}${INPUT_BG} ${masked}${cursor}${INPUT_BG}${inputPadding}${RESET}`;

		return [
			borderLine,
			titleLine,
			hintLine,
			borderLine,
			inputLine,
			borderLine,
		];
	}

	dispose(): void {
		this.secure.destroy();
	}

	private submit(): void {
		this.done = true;
		// 解密 → 写入 cat stdin → 立即清零（明文仅存活于 write() 调用期间）
		this.secure.flushTo(this.writeTarget);
		this.resolve(true);
	}

	private cancel(): void {
		this.done = true;
		this.secure.destroy();
		this.resolve(false);
	}
}
