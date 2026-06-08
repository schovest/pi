/**
 * Minimal TUI implementation with differential rendering
 */

import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { MouseEvent } from "./stdin-buffer.ts";
import type { Terminal } from "./terminal.ts";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import {
	extractSegments,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	snapColToGraphemeBoundary,
	stripAnsi,
	visibleWidth,
} from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

function extractKittyImageIds(line: string): number[] {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i" || value === undefined) continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus.
	 * Return true to indicate the input was consumed and should not be processed further.
	 * Return void or false to allow TUI to handle the input as a fallback.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: void is intentional - implementations may return nothing or boolean
	handleInput?(data: string): boolean | void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

export interface SelectionState {
	active: boolean;
	anchorRow: number;
	anchorCol: number;
	focusRow: number;
	focusCol: number;
}

const AUTO_SCROLL_INTERVAL_MS = 100;
const AUTO_SCROLL_ROWS = 3;

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
	/** ANSI background sequence to fill behind overlay lines (e.g., "\x1b[48;5;235m") */
	background?: string;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the previous target */
	unfocus(): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in render and cursor positioning
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in scroll calculations
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	private fixedBottomCount = 0;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved for future mouse coordinate mapping
	private currentScrollableViewportTop = 0;
	private selection: SelectionState | null = null;
	private scrollOffset = 0;
	private autoFollow = true;
	private previousScrollableLineCount = 0;
	private autoScrollTimer: ReturnType<typeof setInterval> | null = null;
	private mouseListenerRemover?: () => void;
	// Scroll event debouncing: aggregate consecutive wheel events
	private pendingScrollDelta = 0;
	private scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly SCROLL_DEBOUNCE_MS = 8;
	onCopySelection?: (text: string) => void;
	onScrollOffsetChange?: (offset: number) => void;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		focusOrder: number;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				if (this.focusedComponent !== component) {
					this.setFocus(component);
				}
				entry.focusOrder = ++this.focusOrderCounter;
				this.requestRender();
			},
			unfocus: () => {
				if (this.focusedComponent !== component) return;
				const topVisible = this.getTopmostVisibleOverlay();
				this.setFocus(topVisible && topVisible !== entry ? topVisible.component : entry.preFocus);
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.overlayStack[i].options?.nonCapturing) continue;
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.setupMouseListener();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.scrollDebounceTimer) {
			clearTimeout(this.scrollDebounceTimer);
			this.scrollDebounceTimer = null;
		}
		this.clearAutoScrollTimer();
		this.removeMouseListener();
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	private setupMouseListener(): void {
		const stdinBuffer = this.terminal.stdinBuffer;
		if (!stdinBuffer) return;
		const handler = (event: MouseEvent) => this.handleMouseEvent(event);
		stdinBuffer.on("mouse", handler);
		this.mouseListenerRemover = () => {
			stdinBuffer.removeListener("mouse", handler);
		};
	}

	private removeMouseListener(): void {
		if (this.mouseListenerRemover) {
			this.mouseListenerRemover();
			this.mouseListenerRemover = undefined;
		}
	}

	handleMouseEvent(event: MouseEvent): void {
		if (event.type === "mouseWheel") {
			if (this.focusedComponent?.handleInput) {
				const direction = event.button === 64 ? "scrollUp" : "scrollDown";
				const consumed = this.focusedComponent.handleInput(`\x1b[${direction}`);
				this.requestRender();
				if (consumed) return;
			}
			// Aggregate scroll delta for debouncing: first event flushes immediately,
			// subsequent events within the debounce window are accumulated and flushed once
			const delta = event.button === 64 ? AUTO_SCROLL_ROWS : -AUTO_SCROLL_ROWS;
			this.pendingScrollDelta += delta;
			if (!this.scrollDebounceTimer) {
				// First event: flush immediately for responsive feel
				this.flushPendingScroll();
				this.scrollDebounceTimer = setTimeout(() => {
					this.scrollDebounceTimer = null;
					this.flushPendingScroll();
				}, TUI.SCROLL_DEBOUNCE_MS);
			}
			// Otherwise: delta is accumulated, will be flushed when timer fires
			return;
		}
		if (event.button !== 0) return;
		if (event.type === "mouseDown") {
			const screenRow = event.row - 1;
			const rawCol = event.col - 1;
			const line = this.previousLines[screenRow];
			const screenCol = line != null ? snapColToGraphemeBoundary(line, rawCol) : rawCol;
			this.selection = {
				active: true,
				anchorRow: screenRow,
				anchorCol: screenCol,
				focusRow: screenRow,
				focusCol: screenCol,
			};
			this.requestRender();
		} else if (event.type === "mouseMove" && this.selection) {
			const screenRow = event.row - 1;
			const rawCol = event.col - 1;
			const line = this.previousLines[screenRow];
			const screenCol = line != null ? snapColToGraphemeBoundary(line, rawCol) : rawCol;
			this.selection.focusRow = screenRow;
			this.selection.focusCol = screenCol;
			if (event.row <= 1) {
				this.startAutoScroll();
			} else {
				this.clearAutoScrollTimer();
			}
			this.requestRender();
		} else if (event.type === "mouseUp" && this.selection) {
			const text = this.extractSelectionText();
			this.clearAutoScrollTimer();
			this.selection = null;
			this.requestRender();
			if (text && this.onCopySelection) {
				this.onCopySelection(text);
			}
		}
	}

	private getMaxScrollOffset(): number {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const childLines: string[][] = [];
		for (const child of this.children) {
			childLines.push(child.render(width));
		}
		const fixedCount = this.fixedBottomCount;
		let scrollableLines = 0;
		let fixedLines = 0;
		for (let i = 0; i < childLines.length; i++) {
			if (i >= childLines.length - fixedCount) {
				fixedLines += childLines[i].length;
			} else {
				scrollableLines += childLines[i].length;
			}
		}
		const scrollableViewport = Math.max(0, height - fixedLines);
		return Math.max(0, scrollableLines - scrollableViewport);
	}

	/** Flush pending scroll delta and trigger a single render */
	private flushPendingScroll(): void {
		if (this.pendingScrollDelta === 0) return;
		const delta = this.pendingScrollDelta;
		this.pendingScrollDelta = 0;
		if (delta > 0) {
			this.autoFollow = false;
			this.scrollOffset = Math.min(this.getMaxScrollOffset(), this.scrollOffset + delta);
		} else {
			this.scrollOffset = Math.max(0, this.scrollOffset + delta);
			if (this.scrollOffset === 0) this.autoFollow = true;
		}
		this.onScrollOffsetChange?.(this.scrollOffset);
		this.requestRender();
	}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	setScrollOffset(offset: number): void {
		this.scrollOffset = offset;
		this.autoFollow = offset === 0;
		this.onScrollOffsetChange?.(offset);
		this.requestRender();
	}

	resetScrollOffset(): void {
		this.scrollOffset = 0;
		this.autoFollow = true;
		this.onScrollOffsetChange?.(0);
		this.requestRender();
	}

	getAutoFollow(): boolean {
		return this.autoFollow;
	}

	setAutoFollow(value: boolean): void {
		if (this.autoFollow === value) return;
		this.autoFollow = value;
		if (value) {
			this.scrollOffset = 0;
			this.onScrollOffsetChange?.(0);
			this.requestRender();
		}
	}

	setFixedBottomCount(count: number): void {
		this.fixedBottomCount = count;
	}

	private startAutoScroll(): void {
		if (this.autoScrollTimer) return;
		this.autoFollow = false;
		this.autoScrollTimer = setInterval(() => {
			const maxOffset = this.getMaxScrollOffset();
			if (this.scrollOffset < maxOffset) {
				this.scrollOffset = Math.min(maxOffset, this.scrollOffset + AUTO_SCROLL_ROWS);
				this.onScrollOffsetChange?.(this.scrollOffset);
				if (this.selection) {
					this.selection.focusRow = 0;
				}
				this.requestRender();
			}
		}, AUTO_SCROLL_INTERVAL_MS);
	}

	private clearAutoScrollTimer(): void {
		if (this.autoScrollTimer) {
			clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = null;
		}
	}

	private extractSelectionText(): string {
		if (!this.selection) return "";
		const sel = this.selection;
		const lines = this.previousLines;
		if (lines.length === 0) return "";
		const startRow = Math.min(sel.anchorRow, sel.focusRow);
		const endRow = Math.max(sel.anchorRow, sel.focusRow);
		let startCol: number;
		let endCol: number;
		if (startRow === endRow) {
			startCol = Math.min(sel.anchorCol, sel.focusCol);
			endCol = Math.max(sel.anchorCol, sel.focusCol);
		} else {
			startCol = startRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
			endCol = endRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
		}
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

	private applySelectionHighlight(newLines: string[], viewportTop: number, height: number): void {
		if (!this.selection) return;
		const sel = this.selection;
		const startRow = Math.min(sel.anchorRow, sel.focusRow);
		const endRow = Math.max(sel.anchorRow, sel.focusRow);
		let startCol: number;
		let endCol: number;
		if (startRow === endRow) {
			startCol = Math.min(sel.anchorCol, sel.focusCol);
			endCol = Math.max(sel.anchorCol, sel.focusCol);
		} else {
			startCol = startRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
			endCol = endRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
		}
		for (let row = startRow; row <= endRow; row++) {
			const screenRow = row - viewportTop;
			if (screenRow < 0 || screenRow >= height) continue;
			if (row < 0 || row >= newLines.length) continue;
			const line = newLines[row];
			if (isImageLine(line)) continue;
			const lineVisibleWidth = visibleWidth(line);
			const colStart = row === startRow ? Math.min(startCol, lineVisibleWidth) : 0;
			const colEnd = row === endRow ? Math.min(endCol, lineVisibleWidth - 1) : lineVisibleWidth - 1;
			if (colStart > colEnd) continue;
			const before = sliceByColumn(line, 0, colStart, true);
			const highlighted = sliceByColumn(line, colStart, colEnd - colStart + 1);
			const after =
				colEnd + 1 < lineVisibleWidth ? sliceByColumn(line, colEnd + 1, lineVisibleWidth - colEnd - 1) : "";
			newLines[row] = `${before}\x1b[7m${highlighted}\x1b[27m${after}`;
		}
	}

	requestRender(force = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleInput(data: string): void {
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component first. If it returns true, it consumed the input.
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			const consumed = this.focusedComponent.handleInput(data);
			this.requestRender();
			if (consumed) {
				return;
			}
		}

		// Fallback: TUI handles scroll keys when focused component didn't consume them
		if (matchesKey(data, "pageUp")) {
			this.setScrollOffset(this.scrollOffset + this.terminal.rows - 2);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.setScrollOffset(Math.max(0, this.scrollOffset - (this.terminal.rows - 2)));
			return;
		}
		// Ctrl+Home / Ctrl+End: scroll to top/bottom of content
		if (matchesKey(data, "ctrl+home")) {
			this.setScrollOffset(this.getMaxScrollOffset());
			return;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.setScrollOffset(0);
			return;
		}
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number; background?: string }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width, background: options?.background });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w, background: bg } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					let baseLine = result[idx];
					if (bg) {
						baseLine = this.applyOverlayBackground(baseLine, col, w, bg, termWidth);
					}
					result[idx] = this.compositeLineAt(baseLine, truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private expandLastChangedForKittyImages(firstChanged: number, lastChanged: number): number {
		let expandedLastChanged = lastChanged;
		for (let i = firstChanged; i < this.previousLines.length; i++) {
			if (extractKittyImageIds(this.previousLines[i]).length > 0) {
				expandedLastChanged = Math.max(expandedLastChanged, i);
			}
		}
		return expandedLastChanged;
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Apply background fill to the overlay region of a base line. */
	private applyOverlayBackground(
		baseLine: string,
		startCol: number,
		overlayWidth: number,
		bg: string,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;
		const afterStart = startCol + overlayWidth;
		const segments = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
		const r = TUI.SEGMENT_RESET;
		const beforePad = Math.max(0, startCol - segments.beforeWidth);
		const overlayFill = bg + " ".repeat(overlayWidth) + r;
		const afterTarget = Math.max(0, totalWidth - Math.max(startCol, segments.beforeWidth) - overlayWidth);
		const afterPad = Math.max(0, afterTarget - segments.afterWidth);
		return segments.before + " ".repeat(beforePad) + r + overlayFill + segments.after + " ".repeat(afterPad);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private renderingSuspended = false;

	suspendRendering(): void {
		this.renderingSuspended = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.renderRequested = false;
	}

	resumeRendering(): void {
		this.renderingSuspended = false;
		this.requestRender(true);
	}

	private doRender(): void {
		if (this.stopped || this.renderingSuspended) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Render all children to get full content
		const childLines: string[][] = [];
		for (const child of this.children) {
			childLines.push(child.render(width));
		}

		// Split children into scrollable (top) and fixed (bottom)
		// The fixedBottomCount property determines how many trailing children
		// are always pinned to the bottom of the screen
		const fixedCount = this.fixedBottomCount;
		const scrollableLines: string[] = [];
		const fixedLines: string[] = [];
		for (let i = 0; i < childLines.length; i++) {
			if (i >= childLines.length - fixedCount) {
				fixedLines.push(...childLines[i]);
			} else {
				scrollableLines.push(...childLines[i]);
			}
		}

		// Calculate available space for scrollable area
		const fixedHeight = fixedLines.length;
		const scrollableViewport = Math.max(0, height - fixedHeight);

		// Apply scrollOffset to scrollable content only
		const maxScroll = Math.max(0, scrollableLines.length - scrollableViewport);
		const lineCountDelta = scrollableLines.length - this.previousScrollableLineCount;
		if (lineCountDelta > 0) {
			if (this.autoFollow) {
				this.scrollOffset = 0;
			} else if (this.scrollOffset > 0) {
				this.scrollOffset += lineCountDelta;
			}
		}
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		this.previousScrollableLineCount = scrollableLines.length;

		// Determine visible scrollable lines
		const scrollableViewportTop = Math.max(0, scrollableLines.length - scrollableViewport - this.scrollOffset);
		const visibleScrollable = scrollableLines.slice(
			scrollableViewportTop,
			scrollableViewportTop + scrollableViewport,
		);

		// Combine: visible scrollable content + fixed bottom content
		let newLines: string[] = [...visibleScrollable, ...fixedLines];

		// Pad to fill screen height if content is shorter
		while (newLines.length < height) newLines.push("");

		// Truncate to screen height
		newLines = newLines.slice(0, height);

		// Composite overlays
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays([...newLines], width, height);
		}

		const cursorPos = this.extractCursorPosition(newLines, height);
		newLines = this.applyLineResets(newLines);

		// Selection highlight: screen-relative coordinates, no viewportTop offset
		// because newLines is already the viewport (visible lines only)
		this.applySelectionHighlight(newLines, 0, height);

		// Scrollable viewport top in the all-lines buffer (for mouse coordinate mapping)
		this.currentScrollableViewportTop = scrollableViewportTop;

		const renderChanged = (): void => {
			this.fullRedrawCount += 1;
			// Sync mode + cursor home + sequential line output (no full screen clear).
			// \x1b[?2026h defers display until \x1b[?2026l for atomic update.
			// \x1b[K clears to end-of-line after each line to remove residual content
			// from previous renders, replacing the flicker-causing \x1b[2J clear screen.
			// Uses sequential \r\n output (like the original) for minimal bandwidth.
			let buffer = `\x1b[?2026h${TUI.CURSOR_HIDE_PREFIX}\x1b[H`;
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
				buffer += "\x1b[K";
			}
			buffer += this.buildHardwareCursorSequence(cursorPos, newLines.length);
			buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.maxLinesRendered = newLines.length;
			this.previousViewportTop = scrollableViewportTop;
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;

		if (this.previousLines.length === 0) {
			renderChanged();
			return;
		}

		if (widthChanged || (heightChanged && !isTermuxSession())) {
			renderChanged();
			return;
		}

		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			renderChanged();
			return;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";
			if (oldLine !== newLine) {
				if (firstChanged === -1) firstChanged = i;
				lastChanged = i;
			}
		}
		if (newLines.length > this.previousLines.length) {
			if (firstChanged === -1) firstChanged = this.previousLines.length;
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) lastChanged = this.expandLastChangedForKittyImages(firstChanged, lastChanged);

		if (firstChanged === -1) {
			// No content changed, but cursor position may have — wrap in
			// sync mode so the cursor move is atomic with the frame.
			const seq = this.buildHardwareCursorSequence(cursorPos, newLines.length);
			this.terminal.write(`\x1b[?2026h${TUI.CURSOR_HIDE_PREFIX}${seq}\x1b[?2026l`);
			this.previousViewportTop = scrollableViewportTop;
			this.previousHeight = height;
			return;
		}

		if (lastChanged - firstChanged + 1 > height * 0.5 || firstChanged < 0) {
			renderChanged();
			return;
		}

		let buffer = `\x1b[?2026h${TUI.CURSOR_HIDE_PREFIX}`;
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			buffer += `\x1b[${i + 1};1H\x1b[2K\x1b[0m${newLines[i]}`;
		}
		if (newLines.length < this.previousLines.length) {
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += `\x1b[${i + 1};1H\x1b[2K`;
			}
		}
		buffer += this.buildHardwareCursorSequence(cursorPos, newLines.length);
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.previousViewportTop = scrollableViewportTop;
	}

	/**
	 * Build escape sequences for positioning the hardware cursor.
	 * Returned string should be appended to the render buffer *before*
	 * the sync-mode terminator (\x1b[?2026l) so the cursor state change
	 * is atomic with the content update and never causes a visible flash.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private buildHardwareCursorSequence(cursorPos: { row: number; col: number } | null, totalLines: number): string {
		if (!cursorPos || totalLines <= 0) {
			return "\x1b[?25l";
		}

		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		this.hardwareCursorRow = targetRow;

		if (this.showHardwareCursor) {
			return `\x1b[${targetRow + 1};${targetCol + 1}H\x1b[?25h`;
		}
		// Hide then move — both inside the sync-mode buffer so the
		// terminal never shows the cursor at an intermediate position.
		return `\x1b[?25l\x1b[${targetRow + 1};${targetCol + 1}H`;
	}

	/**
	 * Cursor-hide prefix to place at the start of every render buffer,
	 * before any content updates. Guarantees the hardware cursor is
	 * invisible before the terminal processes line changes, which
	 * prevents the cursor from briefly appearing at stale positions
	 * on terminals with imperfect sync-mode support.
	 */
	private static readonly CURSOR_HIDE_PREFIX = "\x1b[?25l";
}
