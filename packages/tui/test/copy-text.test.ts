import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Copy-text restoration: selection copy should yield logical text, free of
 * render-added prefixes (paddingX, code-block indent) and trailing width
 * padding, while keeping real content indentation intact.
 */

async function settleRender(): Promise<void> {
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

describe("Markdown.getCopyLineInfo", () => {
	it("code block lines strip indent/padding and keep content indentation", () => {
		const md = new Markdown("```bash\necho hello\n  indented\n```", 1, 0, defaultMarkdownTheme);
		const lines = md.render(40);

		// Render anchors: line 1 = " " + "  " + "echo hello" + trailing padding (ANSI-stripped)
		const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(strip(lines[1]!).startsWith("   echo hello"));
		assert.ok(strip(lines[1]!).trimEnd().length < strip(lines[1]!).length, "render line has trailing padding");

		// Code content line: no indent prefix, no ANSI, no trailing padding
		assert.deepStrictEqual(md.getCopyLineInfo(1), { text: "echo hello", colOffset: 3, continuation: false });
		// Content's own indentation is preserved (only the render indent is stripped)
		assert.deepStrictEqual(md.getCopyLineInfo(2), { text: "  indented", colOffset: 3, continuation: false });
		// ``` border lines carry no indent and are not sliced
		assert.deepStrictEqual(md.getCopyLineInfo(0), { text: "```bash", colOffset: 1, continuation: false });
		assert.deepStrictEqual(md.getCopyLineInfo(3), { text: "```", colOffset: 1, continuation: false });
	});

	it("plain text lines strip paddingX only", () => {
		const md = new Markdown("hello world", 1, 0, defaultMarkdownTheme);
		md.render(40);
		assert.deepStrictEqual(md.getCopyLineInfo(0), { text: "hello world", colOffset: 1, continuation: false });
	});

	it("wrapped continuation segments carry no indent prefix", () => {
		const md = new Markdown(`${"a".repeat(30)} END`, 1, 0, defaultMarkdownTheme);
		const lines = md.render(20); // contentWidth = 18
		assert.strictEqual(lines.length, 2);
		const info = md.getCopyLineInfo(1);
		assert.ok(info);
		assert.strictEqual(info.colOffset, 1); // paddingX only
		assert.strictEqual(info.continuation, true); // wrap continuation
		assert.strictEqual(info.text, `${"a".repeat(12)} END`);
	});

	it("paddingY rows return null; out-of-range rows return null", () => {
		const md = new Markdown("code", 0, 2, defaultMarkdownTheme);
		md.render(40);
		assert.strictEqual(md.getCopyLineInfo(0), null);
		assert.deepStrictEqual(md.getCopyLineInfo(2), { text: "code", colOffset: 0, continuation: false });
		assert.strictEqual(md.getCopyLineInfo(99), null);
	});
});

describe("TUI selection copy with Markdown content", () => {
	it("copies code block lines without render prefixes or trailing spaces", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.addChild(new Markdown("```bash\necho a\necho b\n```", 1, 0, defaultMarkdownTheme));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// Buffer rows 1-2 ("echo a", "echo b") → screen rows 1-2 → mouse rows 2-3.
		// Drag from col 1 (inside the leading padding) to col 40 (line end).
		const mouse = { button: 0, shift: false, alt: false, ctrl: false };
		tui.handleMouseEvent({ type: "mouseDown", col: 1, row: 2, ...mouse });
		tui.handleMouseEvent({ type: "mouseMove", col: 40, row: 3, ...mouse });
		tui.handleMouseEvent({ type: "mouseUp", col: 40, row: 3, ...mouse });

		assert.strictEqual(copied[0], "echo a\necho b");
	});

	it("maps selection columns through the render prefix offset", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.addChild(new Markdown("```\necho\n```", 1, 0, defaultMarkdownTheme));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// Display row "   echo": cols 0-2 spaces, 'e' at col 3. Select cols 3-6 → "echo".
		const mouse = { button: 0, shift: false, alt: false, ctrl: false };
		tui.handleMouseEvent({ type: "mouseDown", col: 4, row: 2, ...mouse });
		tui.handleMouseEvent({ type: "mouseMove", col: 7, row: 2, ...mouse });
		tui.handleMouseEvent({ type: "mouseUp", col: 7, row: 2, ...mouse });

		assert.strictEqual(copied[0], "echo");
	});

	it("delegates through Container and Box with accumulated offsets", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const box = new Box(1, 1);
		box.addChild(new Markdown("```\nfoo\n```", 0, 0, defaultMarkdownTheme));
		tui.addChild(box);
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// Box renders: 1 padding row, then content rows. The code line is
		// " " (box paddingX) + "  foo" (md indent) → "   foo". Select it fully.
		const mouse = { button: 0, shift: false, alt: false, ctrl: false };
		tui.handleMouseEvent({ type: "mouseDown", col: 1, row: 3, ...mouse });
		tui.handleMouseEvent({ type: "mouseMove", col: 40, row: 3, ...mouse });
		tui.handleMouseEvent({ type: "mouseUp", col: 40, row: 3, ...mouse });

		assert.strictEqual(copied[0], "foo");
	});
});

class PlainLinesComponent implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return [...this.lines];
	}
	invalidate(): void {
		// no-op
	}
}

describe("wrap continuation merging", () => {
	it("Text component marks wrapped continuation segments", () => {
		const text = new Text(`${"a".repeat(30)} END`, 1, 0);
		const lines = text.render(20); // contentWidth = 18
		assert.strictEqual(lines.length, 2);
		const first = text.getCopyLineInfo(0);
		const second = text.getCopyLineInfo(1);
		assert.ok(first && second);
		assert.strictEqual(first.continuation, false);
		assert.strictEqual(second.continuation, true);
		assert.strictEqual(first.colOffset, 1);
		assert.strictEqual(second.colOffset, 1);
		assert.strictEqual(first.text + second.text, `${"a".repeat(30)} END`);
	});

	it("selecting a wrapped Text line copies a single logical line", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.addChild(new Text(`${"a".repeat(60)} tail`, 1, 0));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// 2 wrapped display rows (contentWidth 38). Drag across both.
		const mouse = { button: 0, shift: false, alt: false, ctrl: false };
		tui.handleMouseEvent({ type: "mouseDown", col: 1, row: 1, ...mouse });
		tui.handleMouseEvent({ type: "mouseMove", col: 40, row: 2, ...mouse });
		tui.handleMouseEvent({ type: "mouseUp", col: 40, row: 2, ...mouse });

		assert.strictEqual(copied[0], `${"a".repeat(60)} tail`);
	});

	it("fallback rows trim trailing render padding", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new PlainLinesComponent(["hello world   ", "second"]));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		const mouse = { button: 0, shift: false, alt: false, ctrl: false };
		tui.handleMouseEvent({ type: "mouseDown", col: 1, row: 1, ...mouse });
		tui.handleMouseEvent({ type: "mouseMove", col: 40, row: 2, ...mouse });
		tui.handleMouseEvent({ type: "mouseUp", col: 40, row: 2, ...mouse });

		assert.strictEqual(copied[0], "hello world\nsecond");
	});
});
