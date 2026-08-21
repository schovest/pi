import assert from "node:assert";
import { describe, it } from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

/** Loader 构造要求 TUI 且启动 80ms 帧动画；测试用最小 stub，并在 finally 中 stop 释放定时器。 */
function makeLoader(message: string): Loader {
	return new Loader(
		undefined as unknown as TUI,
		(s) => s,
		(s) => s,
		message,
	);
}

describe("Loader suffix provider", () => {
	it("appends the suffix provider output to the rendered line", () => {
		const loader = makeLoader("Working");
		try {
			loader.setSuffixProvider(() => " · ↓1.2k");
			const lines = loader.render(60);
			assert.ok(lines.join("\n").includes("Working · ↓1.2k"), "suffix should follow the message");
		} finally {
			loader.stop();
		}
	});

	it("renders nothing extra when no suffix provider is set", () => {
		const loader = makeLoader("Working");
		try {
			const lines = loader.render(60);
			assert.ok(lines.join("\n").includes("Working"));
			assert.ok(!lines.join("\n").includes("↓"), "no suffix when provider unset");
		} finally {
			loader.stop();
		}
	});

	it("clears the suffix when set to undefined", () => {
		const loader = makeLoader("Working");
		try {
			loader.setSuffixProvider(() => " · ↓1.2k");
			loader.setSuffixProvider(undefined);
			const lines = loader.render(60);
			assert.ok(!lines.join("\n").includes("↓1.2k"), "suffix cleared after setSuffixProvider(undefined)");
		} finally {
			loader.stop();
		}
	});
});
