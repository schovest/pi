import assert from "node:assert";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "../src/tui.ts";
import { sliceByColumn, snapColToGraphemeBoundary, stripAnsi, visibleWidth } from "../src/utils.ts";

/**
 * Tests for the selection text extraction bug fix.
 *
 * Bug: extractSelectionText() used stripAnsi() + String.slice(col) to extract
 * selected text, but col is a *visible column* coordinate while String.slice()
 * uses *JavaScript string index*. Wide characters (CJK/emoji) take 2 visible
 * columns but only 1 string index, causing the copied text to be offset.
 *
 * Fix: use sliceByColumn() which correctly maps visible column positions
 * to string positions, handling both ANSI codes and wide characters.
 */

describe("sliceByColumn for selection text extraction", () => {
	it("extracts text by visible column from lines with ANSI codes", () => {
		const line = "\x1b[90m│\x1b[39m \x1b[36mSubject\x1b[39m \x1b[90m│\x1b[39m";
		// Visible: │(0) (1) S(2) u(3) b(4) j(5) e(6) c(7) t(8) (9) │(10)
		const result = sliceByColumn(line, 2, 7);
		assert.strictEqual(stripAnsi(result), "Subject");
	});

	it("extracts text by visible column from lines with wide characters", () => {
		const line = "│ 你好 │";
		// Visible: │(0) (1) 你(2-3) 好(4-5) (6) │(7)
		const result = sliceByColumn(line, 2, 4);
		assert.strictEqual(result, "你好");
	});

	it("extracts text from lines with both ANSI and wide characters", () => {
		const line = "\x1b[90m│\x1b[39m \x1b[36m你好\x1b[39m \x1b[90m│\x1b[39m";
		const result = sliceByColumn(line, 2, 4);
		assert.strictEqual(stripAnsi(result), "你好");
	});

	it("extracts full styled text", () => {
		const line = "\x1b[36mValue\x1b[39m";
		const result = sliceByColumn(line, 0, 5);
		assert.strictEqual(stripAnsi(result), "Value");
	});

	it("handles partial wide character at boundary with strict", () => {
		const line = "你好世界";
		// Visible: 你(0-1) 好(2-3) 世(4-5) 界(6-7)
		const result = sliceByColumn(line, 1, 4, true);
		assert.strictEqual(result, "好");
	});

	it("handles partial wide character at boundary without strict", () => {
		const line = "你好世界";
		const result = sliceByColumn(line, 1, 4, false);
		assert.strictEqual(result, "好世");
	});
});

describe("stripAnsi + slice bug: visible column != string index", () => {
	it("wide chars cause stripAnsi+slice to overshoot", () => {
		// "│ 主题 │ 值 │" — selecting "主题" (visible col 2-5)
		const line = "│ 主题 │ 值 │";
		const stripped = stripAnsi(line);
		const buggy = stripped.slice(2, 6); // using visible col as string index
		assert.strictEqual(buggy, "主题 │"); // WRONG — includes trailing chars

		const correct = sliceByColumn(line, 2, 4);
		assert.strictEqual(correct, "主题");
	});

	it("selecting 'subject' after CJK content gets 'bject' (user-reported bug)", () => {
		// "│ 主题 │ subject │" — selecting "subject" (visible col 9-15)
		const line = "│ 主题 │ subject │";
		const stripped = stripAnsi(line);
		const buggy = stripped.slice(9, 16);
		assert.strictEqual(buggy, "bject │"); // off by 2 (2 wide chars before)

		const correct = stripAnsi(sliceByColumn(line, 9, 7));
		assert.strictEqual(correct, "subject");
	});

	it("different offset amounts within same table (user-reported)", () => {
		// Different rows have different wide char counts before the selection,
		// causing different offsets with the old stripAnsi+slice approach.
		const row1 = "│ ABC   │ subject │"; // 0 wide chars before "subject"
		const row2 = "│ 主题  │ subject │"; // 2 wide chars before "subject"
		const row3 = "│ 主题名│ subject │"; // 3 wide chars before "subject"

		// sliceByColumn always correct
		assert.strictEqual(stripAnsi(sliceByColumn(row1, 10, 7)), "subject");
		assert.strictEqual(stripAnsi(sliceByColumn(row2, 10, 7)), "subject");
		assert.strictEqual(stripAnsi(sliceByColumn(row3, 10, 7)), "subject");

		// stripAnsi+slice gives different wrong offsets per row
		assert.strictEqual(stripAnsi(row1).slice(10, 17), "subject"); // correct by luck
		assert.strictEqual(stripAnsi(row2).slice(10, 17), "bject │"); // off by 2
		assert.strictEqual(stripAnsi(row3).slice(10, 17), "ject │"); // off by 3
	});
});

describe("extractSelectionText logic: old vs new", () => {
	function extractSelectionTextOld(
		lines: string[],
		startRow: number,
		endRow: number,
		startCol: number,
		endCol: number,
	): string {
		const parts: string[] = [];
		for (let row = startRow; row <= endRow; row++) {
			if (row < 0 || row >= lines.length) continue;
			const line = stripAnsi(lines[row]);
			if (row === startRow && row === endRow) {
				parts.push(line.slice(startCol, endCol + 1));
			} else if (row === startRow) {
				parts.push(line.slice(startCol));
			} else if (row === endRow) {
				parts.push(line.slice(0, endCol + 1));
			} else {
				parts.push(line);
			}
		}
		return parts.join("\n");
	}

	function extractSelectionTextNew(
		lines: string[],
		startRow: number,
		endRow: number,
		startCol: number,
		endCol: number,
	): string {
		const parts: string[] = [];
		for (let row = startRow; row <= endRow; row++) {
			if (row < 0 || row >= lines.length) continue;
			const line = lines[row];
			if (row === startRow && row === endRow) {
				parts.push(stripAnsi(sliceByColumn(line, startCol, endCol - startCol + 1)));
			} else if (row === startRow) {
				const lineW = visibleWidth(line);
				parts.push(stripAnsi(sliceByColumn(line, startCol, lineW - startCol)));
			} else if (row === endRow) {
				parts.push(stripAnsi(sliceByColumn(line, 0, endCol + 1)));
			} else {
				parts.push(stripAnsi(line));
			}
		}
		return parts.join("\n");
	}

	it("new logic fixes wide character offset", () => {
		const lines = ["│ 主题 │ 值 │"];
		const newResult = extractSelectionTextNew(lines, 0, 0, 2, 5);
		const oldResult = extractSelectionTextOld(lines, 0, 0, 2, 5);
		assert.strictEqual(newResult, "主题");
		assert.notStrictEqual(oldResult, "主题");
	});

	it("new logic fixes ANSI + wide character offset", () => {
		const lines = ["\x1b[90m│\x1b[39m \x1b[36m主题\x1b[39m \x1b[90m│\x1b[39m"];
		const newResult = extractSelectionTextNew(lines, 0, 0, 2, 5);
		assert.strictEqual(newResult, "主题");
	});

	it("both logics agree on plain ASCII", () => {
		const lines = ["Hello World"];
		assert.strictEqual(extractSelectionTextOld(lines, 0, 0, 6, 10), extractSelectionTextNew(lines, 0, 0, 6, 10));
		assert.strictEqual(extractSelectionTextNew(lines, 0, 0, 6, 10), "World");
	});

	it("both logics agree on multi-line plain text", () => {
		const lines = ["Hello", "World"];
		assert.strictEqual(extractSelectionTextOld(lines, 0, 1, 3, 2), extractSelectionTextNew(lines, 0, 1, 3, 2));
		assert.strictEqual(extractSelectionTextNew(lines, 0, 1, 3, 2), "lo\nWor");
	});

	it("new logic handles multi-line with ANSI", () => {
		const lines = ["\x1b[1mHello\x1b[0m", "\x1b[32mWorld\x1b[0m"];
		assert.strictEqual(extractSelectionTextNew(lines, 0, 1, 3, 2), "lo\nWor");
	});

	it("new logic handles multi-line with wide chars", () => {
		const lines = ["你好世界", "测试数据"];
		// Line 0: 你(0-1) 好(2-3) 世(4-5) 界(6-7)
		// Line 1: 测(0-1) 试(2-3) 数(4-5) 据(6-7)
		assert.strictEqual(extractSelectionTextNew(lines, 0, 1, 2, 3), "好世界\n测试");
	});
});

describe("snapColToGraphemeBoundary: mouse click on wide character half", () => {
	it("snaps to start of CJK character when clicking right half", () => {
		const line = "你好世界";
		// 你(0-1) 好(2-3) 世(4-5) 界(6-7)
		// Clicking at col 1 (right half of "你") should snap to 0
		assert.strictEqual(snapColToGraphemeBoundary(line, 1), 0);
	});

	it("snaps to start of CJK character when clicking left half", () => {
		const line = "你好世界";
		// Clicking at col 0 (left half of "你") stays at 0
		assert.strictEqual(snapColToGraphemeBoundary(line, 0), 0);
	});

	it("snaps to start of second CJK character", () => {
		const line = "你好世界";
		// Clicking at col 3 (right half of "好") snaps to 2
		assert.strictEqual(snapColToGraphemeBoundary(line, 3), 2);
	});

	it("returns boundary column for ASCII characters", () => {
		const line = "Hello";
		// All columns are single-width, no snapping needed
		assert.strictEqual(snapColToGraphemeBoundary(line, 0), 0);
		assert.strictEqual(snapColToGraphemeBoundary(line, 3), 3);
		assert.strictEqual(snapColToGraphemeBoundary(line, 5), 5);
	});

	it("handles mixed ASCII and CJK", () => {
		const line = "A你好B";
		// A(0) 你(1-2) 好(3-4) B(5)
		// Clicking at col 2 (right half of "你") snaps to 1
		assert.strictEqual(snapColToGraphemeBoundary(line, 2), 1);
		// Clicking at col 4 (right half of "好") snaps to 3
		assert.strictEqual(snapColToGraphemeBoundary(line, 4), 3);
		// Clicking at col 5 (start of "B") stays at 5
		assert.strictEqual(snapColToGraphemeBoundary(line, 5), 5);
	});

	it("handles line with ANSI codes", () => {
		const line = "\x1b[36m你好\x1b[39m";
		// 你(0-1) 好(2-3), ANSI codes are zero-width
		assert.strictEqual(snapColToGraphemeBoundary(line, 1), 0);
		assert.strictEqual(snapColToGraphemeBoundary(line, 3), 2);
	});

	it("handles emoji (width 2)", () => {
		const line = "🎉Hi";
		// 🎉(0-1) H(2) i(3)
		assert.strictEqual(snapColToGraphemeBoundary(line, 1), 0);
		assert.strictEqual(snapColToGraphemeBoundary(line, 2), 2);
	});

	it("returns 0 for negative column", () => {
		const line = "你好";
		assert.strictEqual(snapColToGraphemeBoundary(line, -1), 0);
	});

	it("returns line width for column beyond line", () => {
		const line = "你好";
		// 你(0-1) 好(2-3), width=4
		assert.strictEqual(snapColToGraphemeBoundary(line, 10), 4);
	});

	it("column at exact grapheme boundary stays unchanged", () => {
		const line = "你好世界";
		// 你(0) 好(2) 世(4) 界(6)
		assert.strictEqual(snapColToGraphemeBoundary(line, 0), 0);
		assert.strictEqual(snapColToGraphemeBoundary(line, 2), 2);
		assert.strictEqual(snapColToGraphemeBoundary(line, 4), 4);
		assert.strictEqual(snapColToGraphemeBoundary(line, 6), 6);
	});
});

describe("selection highlight with snapped columns: wide char integrity", () => {
	it("before + highlighted + after covers entire line without gaps", () => {
		const line = "你好世界";
		// Simulate selection from snapped colStart=2 to snapped colEnd=4
		const colStart = 2;
		const colEnd = 4;
		const lineVisibleWidth = visibleWidth(line);
		const before = sliceByColumn(line, 0, colStart, true);
		const highlighted = sliceByColumn(line, colStart, colEnd - colStart + 1);
		const after = colEnd + 1 < lineVisibleWidth ? sliceByColumn(line, colEnd + 1, lineVisibleWidth - colEnd - 1) : "";
		const combined = before + highlighted + after;
		assert.strictEqual(stripAnsi(combined), "你好世界");
	});

	it("single CJK character selection preserves the character", () => {
		const line = "你好世界";
		// Simulate clicking at col 3 (right half of "好"), snapped to col 2
		const snappedCol = snapColToGraphemeBoundary(line, 3);
		assert.strictEqual(snappedCol, 2);
		const highlighted = sliceByColumn(line, snappedCol, 2);
		assert.strictEqual(highlighted, "好");
	});

	it("CJK at line start: before is empty, highlighted includes full char", () => {
		const line = "你好世界";
		const snappedCol = snapColToGraphemeBoundary(line, 1);
		assert.strictEqual(snappedCol, 0);
		const before = sliceByColumn(line, 0, snappedCol, true);
		assert.strictEqual(before, "");
		const highlighted = sliceByColumn(line, snappedCol, 2);
		assert.strictEqual(highlighted, "你");
	});
});

describe("stripAnsi: APC sequence (CURSOR_MARKER) handling", () => {
	it("strips CURSOR_MARKER (ESC _ pi:c BEL) completely", () => {
		const marker = CURSOR_MARKER; // \x1b_pi:c\x07
		assert.strictEqual(stripAnsi(marker), "");
	});

	it("strips CURSOR_MARKER embedded in text with ANSI styling", () => {
		// Simulates input.ts render output: prompt + marker + reverse-video space
		const line = `> ${CURSOR_MARKER}\x1b[7m \x1b[27m`;
		assert.strictEqual(stripAnsi(line), ">  ");
	});

	it("strips multiple APC sequences in a line", () => {
		const line = `hello${CURSOR_MARKER}world${CURSOR_MARKER}!`;
		assert.strictEqual(stripAnsi(line), "helloworld!");
	});
});
