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
