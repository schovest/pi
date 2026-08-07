import { beforeAll, describe, expect, test, vi } from "vitest";
import { Text } from "../../tui/src/components/text.ts";
import { Container, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

type HintThis = {
	scrollHint: Text;
	scrollHintVisible: boolean;
	ui: { requestRender: () => void };
};

const updateScrollHint = Reflect.get(InteractiveMode.prototype, "updateScrollHint") as (
	this: HintThis,
	offset: number,
) => void;

describe("InteractiveMode scroll down hint", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("updateScrollHint shows the hint when scrolled away from bottom", () => {
		const scrollHint = new Text("", 0, 0);
		const ui = { requestRender: vi.fn() };
		const fakeThis: HintThis = { scrollHint, scrollHintVisible: false, ui };

		updateScrollHint.call(fakeThis, 5);

		expect(fakeThis.scrollHintVisible).toBe(true);
		const rendered = scrollHint.render(120).join("\n");
		expect(rendered).toContain("↓");
		expect(rendered).toContain("新消息");
		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		// 幂等：offset 变化但状态未变，不重复渲染
		updateScrollHint.call(fakeThis, 8);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("updateScrollHint clears the hint when back at the bottom", () => {
		const scrollHint = new Text("", 0, 0);
		const ui = { requestRender: vi.fn() };
		const fakeThis: HintThis = { scrollHint, scrollHintVisible: true, ui };

		updateScrollHint.call(fakeThis, 0);

		expect(fakeThis.scrollHintVisible).toBe(false);
		expect(scrollHint.render(120)).toEqual([]);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("end-to-end: scroll offset drives the hint line in rendered output", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const scrollHint = new Text("", 0, 0);
		const fakeThis: HintThis = { scrollHint, scrollHintVisible: false, ui };

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
