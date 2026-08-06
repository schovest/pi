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

function createTuiWithLines(opts: { lines: string[]; cols?: number; rows?: number; fixedBottomCount?: number }): {
	tui: TUI;
	terminal: VirtualTerminal;
} {
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

		const screenRow0 = (tui as unknown as { screenToBufferRow: (r: number) => number }).screenToBufferRow(0);
		const screenRow5 = (tui as unknown as { screenToBufferRow: (r: number) => number }).screenToBufferRow(5);
		assert.strictEqual(screenRow0, 4);
		assert.strictEqual(screenRow5, 9);

		const buf4 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(4);
		const buf9 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(9);
		assert.strictEqual(buf4, 0);
		assert.strictEqual(buf9, 5);

		const buf0 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(0);
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

		const screenRow0 = (tui as unknown as { screenToBufferRow: (r: number) => number }).screenToBufferRow(0);
		assert.strictEqual(screenRow0, 2);

		const buf2 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(2);
		assert.strictEqual(buf2, 0);
		const buf7 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(7);
		assert.strictEqual(buf7, 5);
	});

	it("maps fixed area: buffer row maps to fixed screen row", async () => {
		const terminal = new VirtualTerminal(40, 9);
		const tui = new TUI(terminal);
		tui.setFixedBottomCount(1);
		tui.addChild(new FixedLinesComponent(Array.from({ length: 10 }, (_, i) => `S${i}`)));
		tui.addChild(new FixedLinesComponent(["F0", "F1", "F2"]));
		tui.requestRender();
		await settleRender();

		// scrollableViewport = 9 - 3 = 6, viewportTop = 10 - 6 = 4
		// Fixed rows start at buffer index 10, 11, 12 → screen rows 6, 7, 8
		const screenFixed0 = (tui as unknown as { screenToBufferRow: (r: number) => number }).screenToBufferRow(6);
		assert.strictEqual(screenFixed0, 10);
		const screenFixed2 = (tui as unknown as { screenToBufferRow: (r: number) => number }).screenToBufferRow(8);
		assert.strictEqual(screenFixed2, 12);

		const buf10 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(10);
		assert.strictEqual(buf10, 6);
		const buf12 = (tui as unknown as { bufferToScreenRow: (r: number) => number }).bufferToScreenRow(12);
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

		// anchor=(0,0), focus=(0,5). startCol=0, endCol=5 inclusive → cols 0..5 = "hello ",
		// trailing render padding is trimmed (copy yields logical text)
		assert.strictEqual(copied.length, 1);
		assert.strictEqual(copied[0], "hello");
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

describe("selection-scroll: plain click without drag", () => {
	it("does not copy on mouseDown→mouseUp at same position", async () => {
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

		// mouseDown at row=1 col=1, then mouseUp at same position — no drag
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });

		assert.strictEqual(copied.length, 0);
	});

	it("does not copy even when clicking on non-whitespace character", async () => {
		const lines = ["ABCDEF"];
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// Click at col=3 (row=1 → col 2 = 'C'), no drag
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 3, row: 1, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 3, row: 1, shift: false, alt: false, ctrl: false });

		assert.strictEqual(copied.length, 0);
	});

	it("still copies after actual drag", async () => {
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

		// Drag from col 1 to col 3 → anchor col 0, focus col 2 → copies "hel"
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 3, row: 1, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 3, row: 1, shift: false, alt: false, ctrl: false });

		assert.strictEqual(copied.length, 1);
		assert.strictEqual(copied[0], "hel");
	});
});

describe("selection-scroll: autoScroll across viewport boundary", () => {
	it("expands selection upward when dragging to top edge", async () => {
		// 20 lines, viewport 6. autoFollow=true → scrollOffset=0.
		// viewportTop = 20 - 6 - 0 = 14. Visible: lines 14..19.
		const lines = Array.from({ length: 20 }, (_, i) => `L${i.toString().padStart(2, "0")}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// mouseDown at screen row 4 (buffer row 17, "L17"), col 10
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 10, row: 4, shift: false, alt: false, ctrl: false });
		// mouseMove to top edge (row=1) triggers autoScroll(-1)
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 10, row: 1, shift: false, alt: false, ctrl: false });

		// Wait enough for at least one autoScroll tick (100ms interval)
		await new Promise<void>((resolve) => setTimeout(resolve, 350));

		// Move away from edge to stop autoScroll, then release at a middle position
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 10, row: 3, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 10, row: 3, shift: false, alt: false, ctrl: false });

		assert.strictEqual(copied.length, 1);
		const text = copied[0]!;
		const includedLines = text.split("\n");
		assert.ok(includedLines.length > 1, `expected multi-line selection, got: ${JSON.stringify(text)}`);
		assert.ok(includedLines.includes("L17"), `expected L17 in selection: ${JSON.stringify(text)}`);
		// Some line from originally-out-of-viewport region (L00..L13) must be included
		const oldViewportLine = includedLines.find((l) => /^L0[0-9]$/.test(l) || /^L1[0-3]$/.test(l));
		assert.ok(oldViewportLine, `expected a line from buffer rows 0-13: ${JSON.stringify(text)}`);
	});

	it("expands selection downward when dragging to bottom edge", async () => {
		// 20 lines, viewport 6. Start scrolled to oldest (max offset).
		const lines = Array.from({ length: 20 }, (_, i) => `L${i.toString().padStart(2, "0")}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// Scroll to oldest (max offset). maxScroll = 20 - 6 = 14.
		const maxOffset = (tui as unknown as { getMaxScrollOffset: () => number }).getMaxScrollOffset();
		tui.setAutoFollow(false);
		tui.setScrollOffset(maxOffset); // = 14
		await settleRender();
		// viewportTop = 20 - 6 - 14 = 0. Visible: lines 0..5.

		// mouseDown at screen row 3 (buffer row 2, "L02"), col 1
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 3, shift: false, alt: false, ctrl: false });
		// mouseMove to bottom of scrollable area (row = lastScrollableViewport = 6, no fixed region)
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 6, shift: false, alt: false, ctrl: false });

		await new Promise<void>((resolve) => setTimeout(resolve, 350));

		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 4, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 1, row: 4, shift: false, alt: false, ctrl: false });

		assert.strictEqual(copied.length, 1);
		const text = copied[0]!;
		const includedLines = text.split("\n");
		assert.ok(includedLines.length > 1, `expected multi-line selection, got: ${JSON.stringify(text)}`);
		assert.ok(includedLines.includes("L02"), `expected L02 in selection: ${JSON.stringify(text)}`);
		// Some line from originally-out-of-viewport region (L06..L19) must be included
		const newLine = includedLines.find((l) => /^L0[6-9]$/.test(l) || /^L1[0-9]$/.test(l));
		assert.ok(newLine, `expected a line from buffer rows 6-19: ${JSON.stringify(text)}`);
	});

	it("does not double-start autoScroll for same direction", async () => {
		// Sanity check: repeated mouseMove at top edge should not stack timers.
		const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 3, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });

		// Internal: only one timer active
		const timerCount = (tui as unknown as { autoScrollTimer: unknown }).autoScrollTimer;
		assert.ok(timerCount !== null && timerCount !== undefined, "autoScrollTimer should be set");

		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });
		// After mouseUp, clearAutoScrollTimer is called
		const timerAfter = (tui as unknown as { autoScrollTimer: unknown }).autoScrollTimer;
		assert.strictEqual(timerAfter, null);
	});

	it("triggers downward autoScroll only at the footer bottom, not the scrollable-area bottom", async () => {
		// 20 scrollable lines + 2 fixed lines, terminal 8 rows.
		// scrollableViewport = 8 - 2 = 6. scrollable region is screen rows 0..5
		// (event.row 1..6), fixed region is screen rows 6..7 (event.row 7..8).
		// autoScroll(+1) should trigger ONLY when the pointer reaches the footer's
		// last row (terminal bottom, event.row = 8), not at the scrollable-area
		// bottom (event.row = 6) — the whole footer acts as a dead zone.
		const scrollableLines = Array.from({ length: 20 }, (_, i) => `L${i.toString().padStart(2, "0")}`);
		const fixedLines = ["FIXED1", "FIXED2"];
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.setFixedBottomCount(1);
		tui.addChild(new FixedLinesComponent(scrollableLines));
		tui.addChild(new FixedLinesComponent(fixedLines));
		const copied: string[] = [];
		tui.onCopySelection = (text) => {
			copied.push(text);
		};
		tui.requestRender();
		await settleRender();

		// Scroll to oldest: maxScroll = 20 - 6 = 14, viewportTop = 0
		tui.setAutoFollow(false);
		tui.setScrollOffset(14);
		await settleRender();

		const getTimer = () => (tui as unknown as { autoScrollTimer: unknown }).autoScrollTimer;

		// mouseDown at screen row 2 (buffer row 2, "L02")
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 3, shift: false, alt: false, ctrl: false });

		// Scrollable-area bottom (event.row = 6) → dead zone, no scroll
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 6, shift: false, alt: false, ctrl: false });
		assert.strictEqual(getTimer(), null, "no autoScroll at scrollable-area bottom");

		// First footer row (event.row = 7) → still a dead zone
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 7, shift: false, alt: false, ctrl: false });
		assert.strictEqual(getTimer(), null, "no autoScroll inside footer dead zone");

		// Footer bottom / terminal bottom (event.row = 8) → scroll kicks in
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 8, shift: false, alt: false, ctrl: false });
		assert.ok(getTimer() !== null && getTimer() !== undefined, "autoScroll should be active at footer bottom");

		// Let it scroll a few ticks
		await new Promise<void>((resolve) => setTimeout(resolve, 350));

		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 4, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseUp", button: 0, col: 1, row: 4, shift: false, alt: false, ctrl: false });

		assert.strictEqual(copied.length, 1);
		const text = copied[0]!;
		const includedLines = text.split("\n");
		assert.ok(includedLines.length > 1, `expected multi-line selection, got: ${JSON.stringify(text)}`);
		assert.ok(includedLines.includes("L02"), `expected L02 in selection: ${JSON.stringify(text)}`);
		// Should have scrolled down enough to include lines beyond the original viewport
		const newLine = includedLines.find((l) => /^L0[6-9]$/.test(l) || /^L1[0-9]$/.test(l));
		assert.ok(newLine, `expected a line from buffer rows 6-19: ${JSON.stringify(text)}`);
	});
});

describe("selection-scroll: highlight survives scroll", () => {
	it("keeps highlight anchored to buffer content after wheel scroll (no drag during scroll)", async () => {
		// 10 lines, viewport 6. mouseDown on L9 (last visible line), drag to select L9 only,
		// wheel scroll up by 3 lines. Highlight should be on L9 content (or off-screen).
		// Use terminal.write interception because xterm's translateToString doesn't preserve SGR.
		const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();
		// viewportTop = 10 - 6 - 0 = 4. Visible: L4..L9.

		// Intercept terminal.write to capture ANSI output for highlight inspection
		const writes: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			origWrite(data);
		};

		// Set selection directly on buffer row 9 ("L9") to avoid mouseMove
		// at the viewport edge triggering an autoScroll interval that never
		// gets cleared (no mouseUp in this test).
		(tui as unknown as { selection: import("../src/tui.ts").SelectionState | null }).selection = {
			active: true,
			anchorRow: 9,
			anchorCol: 0,
			focusRow: 9,
			focusCol: 1,
		};
		tui.requestRender();
		await settleRender();

		// Verify highlight is written (screen row 5 = buffer row 9 "L9")
		const hasHighlight = writes.some((w) => w.includes("\x1b[7m"));
		assert.ok(hasHighlight, "expected highlight on L9 before scroll");

		// Wheel scroll up 3 lines (button 64 = scrollUp → scrollOffset increases)
		writes.length = 0;
		tui.handleMouseEvent({ type: "mouseWheel", button: 64, col: 1, row: 3, shift: false, alt: false, ctrl: false });
		await settleRender();
		// scrollOffset = 3, viewportTop = 1. L9 off-screen (buffer row 9 > last visible 6).
		const hasHighlightAfterScroll = writes.some((w) => w.includes("\x1b[7m"));
		assert.strictEqual(hasHighlightAfterScroll, false, "L9 should be off-screen after scroll, no highlight visible");

		// Scroll back down (button 65 = scrollDown → scrollOffset decreases)
		writes.length = 0;
		tui.handleMouseEvent({ type: "mouseWheel", button: 65, col: 1, row: 3, shift: false, alt: false, ctrl: false });
		await settleRender();
		// scrollOffset = 0 again, viewportTop = 4. L9 back on screen row 5.
		const hasHighlightBack = writes.some((w) => w.includes("\x1b[7m"));
		assert.ok(hasHighlightBack, "expected highlight back on L9 after scroll down");
	});

	it("highlights correct screen row when selection partially outside viewport", async () => {
		// 10 lines, viewport 6. Select from L3 (buffer row 3) to L7 (buffer row 7).
		// viewportTop=4 → L4..L9 visible. Selection 3..7 overlaps at L4..L7 (screen rows 0..3).
		// Use xterm cell attribute inspection (fg field stores inverse flag as 1<<26).
		const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		// Set selection directly: buffer rows 3..7, cols 0..1
		(tui as unknown as { selection: import("../src/tui.ts").SelectionState | null }).selection = {
			active: true,
			anchorRow: 3,
			anchorCol: 0,
			focusRow: 7,
			focusCol: 1,
		};
		tui.requestRender();
		await settleRender();
		await terminal.flush();

		// Read xterm cell attributes to detect inverse video (fg !== 0 = inverse flag set)
		const buf = (
			terminal as unknown as {
				xterm: { buffer: { active: { viewportY: number; getLine: (n: number) => unknown } } };
			}
		).xterm.buffer.active;
		for (let screenRow = 0; screenRow < 6; screenRow++) {
			const line = buf.getLine(buf.viewportY + screenRow) as { getCell: (c: number) => unknown } | null;
			const cell = line?.getCell(0);
			const isInverse = cell ? (cell as unknown as { fg: number }).fg !== 0 : false;
			if (screenRow <= 3) {
				assert.ok(isInverse, `screen row ${screenRow} should be highlighted`);
			} else {
				assert.ok(!isInverse, `screen row ${screenRow} should not be highlighted`);
			}
		}
	});
});

describe("selection-scroll: extractSelectionText from buffer", () => {
	it("extracts text spanning content beyond a single viewport", async () => {
		// 30 lines, viewport 6. autoFollow → scrollOffset=0, only L24..L29 visible.
		// Programmatically set selection spanning buffer rows 5..25.
		const lines = Array.from({ length: 30 }, (_, i) => `L${i.toString().padStart(2, "0")}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		(
			tui as unknown as {
				selection: {
					active: boolean;
					anchorRow: number;
					anchorCol: number;
					focusRow: number;
					focusCol: number;
				} | null;
			}
		).selection = {
			active: true,
			anchorRow: 5,
			anchorCol: 0,
			focusRow: 25,
			focusCol: 2, // covers "L25" (L=0,2=1,5=2 → col 2 inclusive = "L25")
		};

		const text = (tui as unknown as { extractSelectionText: () => string }).extractSelectionText();
		// Buffer rows 5..25. startCol=0 (anchor at row 5), endCol=2 (focus at row 25).
		// Middle rows (6..24): rowStartCol=0, rowEndCol=visibleWidth-1=2 → full "Lxx".
		// End row 25: cols 0..2 → "L25"
		// Start row 5: cols 0..2 → "L05"
		const expected = Array.from({ length: 21 }, (_, i) => `L${(5 + i).toString().padStart(2, "0")}`);
		assert.strictEqual(text, expected.join("\n"));
	});

	it("extractSelectionText clamps selection partially outside buffer bounds", async () => {
		const lines = ["only line"];
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		(
			tui as unknown as {
				selection: {
					active: boolean;
					anchorRow: number;
					anchorCol: number;
					focusRow: number;
					focusCol: number;
				} | null;
			}
		).selection = {
			active: true,
			anchorRow: -2,
			anchorCol: 0,
			focusRow: 5,
			focusCol: 3,
		};

		const text = (tui as unknown as { extractSelectionText: () => string }).extractSelectionText();
		// Only buffer row 0 is valid. anchorCol=0, focusCol=3.
		// startRow=-2, endRow=5. Loop row -2..5, only row 0 valid.
		// Row 0 is both start and end? No: startRow=min(-2,5)=-2, endRow=max(-2,5)=5.
		// Row 0 is neither start nor end (start=-2, end=5). So rowStartCol=0, rowEndCol=visibleWidth("only line")-1=8.
		// → "only line" (full line)
		assert.strictEqual(text, "only line");
	});

	it("extractSelectionText returns empty for selection entirely outside buffer", async () => {
		const lines = ["a", "b"];
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		(
			tui as unknown as {
				selection: {
					active: boolean;
					anchorRow: number;
					anchorCol: number;
					focusRow: number;
					focusCol: number;
				} | null;
			}
		).selection = {
			active: true,
			anchorRow: 10,
			anchorCol: 0,
			focusRow: 20,
			focusCol: 5,
		};

		const text = (tui as unknown as { extractSelectionText: () => string }).extractSelectionText();
		assert.strictEqual(text, "");
	});

	it("extractSelectionText returns empty when no selection", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(["a", "b"]));
		tui.requestRender();
		await settleRender();

		const text = (tui as unknown as { extractSelectionText: () => string }).extractSelectionText();
		assert.strictEqual(text, "");
	});
});

describe("overlay-selection: currentCompositedLines cache", () => {
	it("caches composited lines after render with overlay", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(Array.from({ length: 6 }, (_, i) => `base${i}`)));
		tui.requestRender();
		await settleRender();

		// Show an overlay covering the full screen
		const overlay = new FixedLinesComponent(Array.from({ length: 6 }, (_, i) => `ovly${i}`));
		tui.showOverlay(overlay, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
		tui.requestRender();
		await settleRender();

		const composited = (tui as unknown as { currentCompositedLines: string[] }).currentCompositedLines;
		assert.ok(composited.length > 0, "currentCompositedLines should be populated");
		// After overlay compositing, the lines should contain overlay content, not base content
		const hasOverlayContent = composited.some((line) => line.includes("ovly"));
		assert.ok(hasOverlayContent, `expected overlay content in composited lines, got: ${JSON.stringify(composited)}`);
	});

	it("currentCompositedLines is empty before first render", () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const composited = (tui as unknown as { currentCompositedLines: string[] }).currentCompositedLines;
		assert.strictEqual(composited.length, 0);
	});
});

describe("overlay-selection: extractSelectionText from overlay content", () => {
	it("extracts text from overlay-composited lines, not base content", async () => {
		// Base content is "base0".."base5". Overlay covers full screen with "ovly0".."ovly5".
		// Selecting should extract overlay text, not base text.
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(Array.from({ length: 6 }, (_, i) => `base${i}`)));
		tui.requestRender();
		await settleRender();

		const overlay = new FixedLinesComponent(Array.from({ length: 6 }, (_, i) => `ovly${i}`));
		tui.showOverlay(overlay, {
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
			selectionClip: () => ({ col: 0, width: 20 }),
		});
		tui.requestRender();
		await settleRender();

		// Set selection spanning buffer rows 0..2 (all within viewport)
		(
			tui as unknown as {
				selection: {
					active: boolean;
					anchorRow: number;
					anchorCol: number;
					focusRow: number;
					focusCol: number;
				} | null;
			}
		).selection = {
			active: true,
			anchorRow: 0,
			anchorCol: 0,
			focusRow: 2,
			focusCol: 4, // "ovly2" = 5 chars, col 4 inclusive = full line
		};

		const text = (tui as unknown as { extractSelectionText: () => string }).extractSelectionText();
		// Should extract overlay content: "ovly0", "ovly1", "ovly2"
		assert.strictEqual(text, "ovly0\novly1\novly2");
	});

	it("extracts from currentFullLines when no overlay covers the row", async () => {
		// No overlay — should use currentFullLines (same as before)
		const lines = ["AAAAA", "BBBBB", "CCCCC"];
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		(
			tui as unknown as {
				selection: {
					active: boolean;
					anchorRow: number;
					anchorCol: number;
					focusRow: number;
					focusCol: number;
				} | null;
			}
		).selection = {
			active: true,
			anchorRow: 0,
			anchorCol: 0,
			focusRow: 2,
			focusCol: 4,
		};

		const text = (tui as unknown as { extractSelectionText: () => string }).extractSelectionText();
		assert.strictEqual(text, "AAAAA\nBBBBB\nCCCCC");
	});
});

describe("overlay-selection: mouseDown/mouseMove snap uses composited lines", () => {
	it("mouseDown on overlay row snaps column using overlay content", async () => {
		// Overlay line is shorter than base line. Snap should use overlay width.
		// Base: "XXXXXXXXXXXX" (12 chars). Overlay: "HI" (2 chars).
		// Clicking at col 14 (beyond base line's 12-char width) should snap to
		// the composited line's width (20 cols) instead of the base line's width.
		// Old code (base line): anchorCol = 12 (clamped to 12-char base)
		// New code (composited line): anchorCol = 13 (within 20-char composited)
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(["XXXXXXXXXXXX"]));
		tui.requestRender();
		await settleRender();

		const overlay = new FixedLinesComponent(["HI"]);
		tui.showOverlay(overlay, {
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
			selectionClip: () => ({ col: 0, width: 20 }),
		});
		tui.requestRender();
		await settleRender();

		// mouseDown at row=1, col=14 (beyond base line width of 12, within composited width of 20)
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 14, row: 1, shift: false, alt: false, ctrl: false });

		const selection = (tui as unknown as { selection: { anchorCol: number } | null }).selection;
		assert.ok(selection, "selection should be set after mouseDown");
		// Old code (base line "XXXXXXXXXXXX"): snapColToGraphemeBoundary clamps at 12
		// New code (composited line with "HI" padded to 20 cols): snapColToGraphemeBoundary gives 13
		// anchorCol === 13 proves the composited line was used
		assert.strictEqual(
			selection.anchorCol,
			13,
			`anchorCol should be 13 (snapped within 20-char composited line), got ${selection.anchorCol}`,
		);
	});
});

describe("overlay-selection: clearSelection", () => {
	it("clears selection and autoScroll timer", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(lines));
		tui.requestRender();
		await settleRender();

		// Create a selection
		tui.handleMouseEvent({ type: "mouseDown", button: 0, col: 1, row: 3, shift: false, alt: false, ctrl: false });
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 5, row: 3, shift: false, alt: false, ctrl: false });

		// Trigger autoScroll to set the timer
		tui.handleMouseEvent({ type: "mouseMove", button: 0, col: 1, row: 1, shift: false, alt: false, ctrl: false });

		const selectionBefore = (tui as unknown as { selection: unknown }).selection;
		const timerBefore = (tui as unknown as { autoScrollTimer: unknown }).autoScrollTimer;
		assert.ok(selectionBefore, "selection should exist before clear");
		assert.ok(timerBefore, "autoScrollTimer should exist before clear");

		tui.clearSelection();

		const selectionAfter = (tui as unknown as { selection: unknown }).selection;
		const timerAfter = (tui as unknown as { autoScrollTimer: unknown }).autoScrollTimer;
		assert.strictEqual(selectionAfter, null, "selection should be null after clear");
		assert.strictEqual(timerAfter, null, "autoScrollTimer should be null after clear");
	});

	it("clearSelection is safe when no selection exists", () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		tui.addChild(new FixedLinesComponent(["a"]));
		// Should not throw
		tui.clearSelection();
		assert.strictEqual((tui as unknown as { selection: unknown }).selection, null);
	});
});
