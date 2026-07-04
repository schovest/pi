import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FixedLinesComponent implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return [...this.lines];
	}
	handleInput(_input: string): boolean {
		return false;
	}
	invalidate(): void {
		// no-op
	}
}

function createTuiWithLines(opts: {
	lines: string[];
	cols?: number;
	rows?: number;
	fixedBottomCount?: number;
}): { tui: TUI; terminal: VirtualTerminal } {
	const cols = opts.cols ?? 40;
	const rows = opts.rows ?? 6;
	const terminal = new VirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	tui.setFixedBottomCount(opts.fixedBottomCount ?? 0);
	tui.addChild(new FixedLinesComponent(opts.lines));
	return { tui, terminal };
}

async function settleRender(): Promise<void> {
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

describe("selection-scroll: screenToBufferRow / bufferToScreenRow", () => {
	it("maps screen row to buffer row in scrollable area", async () => {
		// 10 lines, viewport 6 rows, autoFollow=true → scrollOffset=0
		// viewportTop = 10 - 6 - 0 = 4
		const { tui } = createTuiWithLines({
			lines: Array.from({ length: 10 }, (_, i) => `L${i}`),
			rows: 6,
		});
		tui.requestRender();
		await settleRender();

		const screenRow0 = (
			tui as unknown as { screenToBufferRow: (r: number) => number }
		).screenToBufferRow(0);
		const screenRow5 = (
			tui as unknown as { screenToBufferRow: (r: number) => number }
		).screenToBufferRow(5);
		assert.strictEqual(screenRow0, 4);
		assert.strictEqual(screenRow5, 9);

		const buf4 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(4);
		const buf9 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(9);
		assert.strictEqual(buf4, 0);
		assert.strictEqual(buf9, 5);

		const buf0 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(0);
		assert.strictEqual(buf0, -1);
	});

	it("maps screen row correctly after scroll", async () => {
		const { tui } = createTuiWithLines({
			lines: Array.from({ length: 10 }, (_, i) => `L${i}`),
			rows: 6,
		});
		tui.requestRender();
		await settleRender();

		tui.setScrollOffset(2);
		await settleRender();

		const screenRow0 = (
			tui as unknown as { screenToBufferRow: (r: number) => number }
		).screenToBufferRow(0);
		assert.strictEqual(screenRow0, 2);

		const buf2 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(2);
		assert.strictEqual(buf2, 0);
		const buf7 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(7);
		assert.strictEqual(buf7, 5);
	});

	it("maps fixed area: buffer row maps to fixed screen row", async () => {
		const terminal = new VirtualTerminal(40, 9);
		const tui = new TUI(terminal);
		tui.setFixedBottomCount(1);
		tui.addChild(
			new FixedLinesComponent(
				Array.from({ length: 10 }, (_, i) => `S${i}`),
			),
		);
		tui.addChild(new FixedLinesComponent(["F0", "F1", "F2"]));
		tui.requestRender();
		await settleRender();

		// scrollableViewport = 9 - 3 = 6, viewportTop = 10 - 6 = 4
		// Fixed rows start at buffer index 10, 11, 12 → screen rows 6, 7, 8
		const screenFixed0 = (
			tui as unknown as { screenToBufferRow: (r: number) => number }
		).screenToBufferRow(6);
		assert.strictEqual(screenFixed0, 10);
		const screenFixed2 = (
			tui as unknown as { screenToBufferRow: (r: number) => number }
		).screenToBufferRow(8);
		assert.strictEqual(screenFixed2, 12);

		const buf10 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(10);
		assert.strictEqual(buf10, 6);
		const buf12 = (
			tui as unknown as { bufferToScreenRow: (r: number) => number }
		).bufferToScreenRow(12);
		assert.strictEqual(buf12, 8);
	});
});

describe("selection-scroll: mouseDown→mouseUp without scroll", () => {
	it("selects and copies a single-line drag selection", async () => {
		const lines = ["hello world"];
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// mouseDown at row=1 col=1 → anchor at (buffer row 0, col 0) = 'h'
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });
		// mouseMove at row=1 col=6 → focus at (buffer row 0, col 5) = ' '
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 6, row: 1, shift: false, alt: false, ctrl: false });
		// mouseUp finalizes the selection (does not update focus)
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 6, row: 1, shift: false, alt: false, ctrl: false });

		// anchor=(0,0), focus=(0,5). startCol=0, endCol=5 inclusive → cols 0..5 = "hello "
		assert.strictEqual(copied.length, 1);
		assert.strictEqual(copied[0], "hello ");
	});

	it("selects multi-line drag range within viewport", async () => {
		const lines = ["ABCDE", "FGHIJ", "KLMNO"];
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// 3 lines, all fit in viewport (height 6). viewportTop = 0.
		// mouseDown at row=1 col=2 → anchor at (buffer row 0, col 1) = 'B'
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 2, row: 1, shift: false, alt: false, ctrl: false });
		// mouseMove at row=3 col=4 → focus at (buffer row 2, col 3) = 'M'
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 4, row: 3, shift: false, alt: false, ctrl: false });
		// mouseUp finalizes the selection
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 4, row: 3, shift: false, alt: false, ctrl: false });

		// anchor=(0,1), focus=(2,3). startRow=0, endRow=2.
		// Row 0 (start row, not end row): startCol=1, rowEndCol=visibleWidth-1=4 → cols 1..4 = "BCDE"
		// Row 1 (middle): full line = "FGHIJ"
		// Row 2 (end row): startCol=0, rowEndCol=endCol=3 → cols 0..3 = "KLMN"
		// Result: "BCDE\nFGHIJ\nKLMN"
		assert.strictEqual(copied[0], "BCDE\nFGHIJ\nKLMN");
	});
});
