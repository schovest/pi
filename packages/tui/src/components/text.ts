import type { Component, CopyLineInfo } from "../tui.ts";
import { applyBackgroundToLine, stripAnsi, visibleWidth, wrapTextWithAnsiDetailed } from "../utils.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Copyable text per rendered content line (aligned with render output minus paddingY)
	private copyLineInfos: CopyLineInfo[] = [];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			this.copyLineInfos = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Calculate content width (subtract left/right margins)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedDetailed = wrapTextWithAnsiDetailed(normalizedText, contentWidth);
		const copyLineInfos: CopyLineInfo[] = wrappedDetailed.map((w) => ({
			text: stripAnsi(w.line),
			colOffset: this.paddingX,
			continuation: !w.firstOfLine,
		}));

		// Add margins and background to each line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const contentLines: string[] = [];

		for (const { line } of wrappedDetailed) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];
		this.copyLineInfos = copyLineInfos;

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Copyable text for a rendered line: strips padding and trailing width
	 * padding; wrapped continuation segments merge into their logical line.
	 */
	getCopyLineInfo(row: number): CopyLineInfo | null {
		const contentRow = row - this.paddingY;
		const info = this.copyLineInfos[contentRow];
		return info ?? null;
	}
}
