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
});
