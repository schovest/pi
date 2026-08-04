import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #3686: session name changes emit an event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits session_info_changed when AgentSession.setSessionName is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setSessionName("hello world");

		expect(harness.sessionManager.getSessionName()).toBe("hello world");
		const events = harness.eventsOfType("session_info_changed");
		expect(events.map((event) => event.name)).toEqual(["hello world"]);
		// 事件携带会话标识，扩展可区分改名的是哪个会话
		expect(events.map((event) => event.sessionFile)).toEqual([harness.sessionManager.getSessionFile()]);
	});

	it("emits session_info_changed when an extension calls pi.setSessionName", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);

		api?.setSessionName("from extension");

		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		const events = harness.eventsOfType("session_info_changed");
		expect(events.map((event) => event.name)).toEqual(["from extension"]);
		expect(events.map((event) => event.sessionFile)).toEqual([harness.sessionManager.getSessionFile()]);
	});

	it("picker 对当前会话改名走 setSessionName：事件名/会话标识/live 状态一致且规范化", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// picker Ctrl+R 对当前会话改名 → 统一走 AgentSession.setSessionName（不再走 detached manager）
		harness.session.setSessionName("  new-name\r\nwith breaks  ");

		// live manager 内存态即时更新（旧实现 detached 写入后仍返回旧名）
		expect(harness.sessionManager.getSessionName()).toBe("new-name with breaks");
		const events = harness.eventsOfType("session_info_changed");
		const last = events[events.length - 1]!;
		// 事件名与 getSessionName() 一致（\r\n→空格 + trim 的规范化语义）
		expect(last.name).toBe("new-name with breaks");
		expect(last.sessionFile).toBe(harness.sessionManager.getSessionFile());

		// 后续 append 不改名（detached 写入会在下次 append 回退 meta）
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: 1700000000000,
		});
		expect(harness.sessionManager.getSessionName()).toBe("new-name with breaks");
	});
});
