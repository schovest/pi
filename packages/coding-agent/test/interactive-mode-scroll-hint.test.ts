import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, TUI } from "../../tui/src/tui.ts";
import { visibleWidth } from "../../tui/src/utils.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

type HintThis = {
	scrollHintVisible: boolean;
	ui: { requestRender: () => void };
};

const updateScrollHint = Reflect.get(InteractiveMode.prototype, "updateScrollHint") as (
	this: HintThis,
	offset: number,
) => void;

const renderScrollHint = Reflect.get(InteractiveMode, "renderScrollHint") as (
	width: number,
	visible: boolean,
) => string[];

describe("InteractiveMode scroll down hint", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renderScrollHint centers the hint text when visible", () => {
		const text = "↓ 新消息";
		const expectedPad = Math.max(0, Math.floor((120 - visibleWidth(text)) / 2));
		const lines = renderScrollHint(120, true);
		expect(lines).toHaveLength(1);
		const stripped = lines[0]!.replace(/\u001b\[[0-9;]*m/g, "");
		expect(stripped.startsWith(" ".repeat(expectedPad))).toBe(true);
		expect(stripped.trim()).toBe(text);
	});

	test("renderScrollHint renders nothing when hidden", () => {
		expect(renderScrollHint(120, false)).toEqual([]);
	});

	test("updateScrollHint toggles visibility idempotently", () => {
		const ui = { requestRender: vi.fn() };
		const fakeThis: HintThis = { scrollHintVisible: false, ui };

		updateScrollHint.call(fakeThis, 5);
		expect(fakeThis.scrollHintVisible).toBe(true);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		// 幂等：offset 变化但状态未变，不重复渲染
		updateScrollHint.call(fakeThis, 8);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		updateScrollHint.call(fakeThis, 0);
		expect(fakeThis.scrollHintVisible).toBe(false);
		expect(ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("end-to-end: scroll offset drives the hint line in rendered output", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const fakeThis: HintThis = { scrollHintVisible: false, ui };
		const scrollHint: Component = {
			render: (width) => renderScrollHint(width, fakeThis.scrollHintVisible),
			invalidate: () => {},
		};

		// 模拟 init() 中的挂接
		ui.onScrollOffsetChange = (offset) => updateScrollHint.call(fakeThis, offset);

		const content = new Container();
		content.addChild({
			render: () => Array.from({ length: 40 }, (_, i) => `line-${i}`),
			invalidate: () => {},
		});
		ui.addChild(content);
		ui.addChild(scrollHint);
		ui.setFixedBottomCount(1);
		ui.start();
		try {
			await flushTui(ui, terminal);
			expect(terminal.getViewport().join("\n")).not.toContain("新消息");

			ui.setScrollOffset(5);
			await flushTui(ui, terminal);
			expect(terminal.getViewport().join("\n")).toContain("新消息");

			ui.setScrollOffset(0);
			await flushTui(ui, terminal);
			expect(terminal.getViewport().join("\n")).not.toContain("新消息");
		} finally {
			ui.stop();
		}
	});
});
