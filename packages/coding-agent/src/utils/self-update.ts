/**
 * update.sh 式 self-update 运行器。
 *
 * 用于 Bun 编译二进制安装（install.sh / update.sh 方式）的 pi 自更新。
 * npm/pnpm/yarn 等包管理器安装的 self-update 由 package-manager-cli.ts 中
 * 的 npm 路径处理，不经过这里。
 */
import { spawnProcess } from "./child-process.ts";

/** update.sh 在 GitHub 上的原始链接 */
const UPDATE_SCRIPT_URL = "https://raw.githubusercontent.com/schovest/pi/main/scripts/update.sh";

export interface ScriptSelfUpdateResult {
	/** 子进程退出码（0 = 成功） */
	exitCode: number | null;
	/** 是否因为平台不支持而跳过（未实际执行） */
	unsupported: boolean;
	/** 跳过原因（unsupported=true 时有值） */
	reason?: string;
}

/**
 * 检测当前平台是否支持 update.sh（需要 bash + curl）。
 * 返回 undefined 表示支持，否则返回不支持的原因。
 */
export function checkScriptSelfUpdateSupported(): string | undefined {
	if (process.platform === "win32") {
		return "self-update via update.sh is not supported on Windows";
	}
	return undefined;
}

/**
 * 运行 update.sh 完成 self-update。
 *
 * 等价于在终端执行：
 *   curl -fsSL https://raw.githubusercontent.com/schovest/pi/main/scripts/update.sh | bash
 *
 * update.sh 内部已包含版本检查：已安装且为最新版本时自动跳过，
 * 因此调用方无需预先做版本比较。
 *
 * @param force 设为 true 时传递 PI_FORCE_UPDATE=1，强制跳过版本检查
 *
 * 子进程以 stdio:"inherit" 运行，直接接管终端输入输出。
 */
export async function runScriptSelfUpdate(force?: boolean): Promise<ScriptSelfUpdateResult> {
	const unsupportedReason = checkScriptSelfUpdateSupported();
	if (unsupportedReason) {
		return { exitCode: null, unsupported: true, reason: unsupportedReason };
	}

	const env = force ? { ...process.env, PI_FORCE_UPDATE: "1" } : process.env;

	return new Promise<ScriptSelfUpdateResult>((resolve) => {
		// curl 下载 update.sh 并通过管道交给 bash 执行
		const child = spawnProcess("bash", ["-c", `curl -fsSL ${UPDATE_SCRIPT_URL} | bash`], {
			stdio: "inherit",
			env,
		});

		child.on("error", (error) => {
			resolve({
				exitCode: null,
				unsupported: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		});

		child.on("close", (code) => {
			resolve({ exitCode: code, unsupported: false });
		});
	});
}
