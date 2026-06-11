import { describe, expect, it } from "vitest";
import type { SubagentRunResult } from "../src/core/subagents/types.ts";
import {
	type SubagentDetailsData,
	SubagentPickerComponent,
	SubagentRunViewComponent,
} from "../src/modes/interactive/components/subagent-details.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SubagentDetailsComponent", () => {
	it("selects a subagent from the running agents list", () => {
		initTheme("dark");
		const result: SubagentRunResult = {
			mode: "parallel",
			results: [
				{
					index: 0,
					agent: "explorer",
					task: "inspect files",
					title: "inspect files",
					status: "success",
					output: "explorer output",
					model: "faux/one",
					thinking: "low",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					messages: [],
					events: [
						{
							runId: "run",
							index: 0,
							agent: "explorer",
							task: "inspect files",
							title: "inspect files",
							status: "running",
							model: "faux/one",
							thinking: "low",
							currentTool: "grep",
							timestamp: 1,
						},
					],
				},
				{
					index: 1,
					agent: "worker",
					task: "review patch",
					title: "review patch",
					status: "failed",
					output: "",
					error: "review failed",
					model: "faux/two",
					thinking: "high",
					usage: {
						input: 4,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 9,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					messages: [],
					events: [
						{
							runId: "run",
							index: 1,
							agent: "worker",
							task: "review patch",
							title: "review patch",
							status: "failed",
							model: "faux/two",
							thinking: "high",
							error: "review failed",
							timestamp: 2,
						},
					],
				},
			],
		};

		const selected: number[] = [];
		const component = new SubagentPickerComponent(
			{ result, events: result.results.flatMap((item) => item.events) },
			(index) => selected.push(index),
			() => {},
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("inspect files");
		expect(rendered).toContain("review patch");
		expect(rendered).toContain("Select a subagent");

		component.handleInput("j");
		component.handleInput("\n");
		// resultItems sorts by timestamp descending (newest first), so index 1 (ts=2) is at position 0
		// and index 0 (ts=1) is at position 1. "j" moves from position 0 → 1, which is index 0.
		expect(selected).toEqual([0]);
	});

	it("renders the selected subagent as a focused run view", () => {
		initTheme("dark");
		const result: SubagentRunResult = {
			mode: "parallel",
			results: [
				{
					index: 0,
					agent: "explorer",
					task: "inspect files",
					title: "inspect files",
					status: "success",
					output: "explorer output",
					model: "faux/one",
					thinking: "low",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					messages: [],
					events: [
						{
							runId: "run",
							index: 0,
							agent: "explorer",
							task: "inspect files",
							title: "inspect files",
							status: "running",
							model: "faux/one",
							thinking: "low",
							currentTool: "grep",
							timestamp: 1,
						},
					],
				},
				{
					index: 1,
					agent: "worker",
					task: "review patch",
					title: "review patch",
					status: "failed",
					output: "",
					error: "review failed",
					model: "faux/two",
					thinking: "high",
					usage: {
						input: 4,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 9,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					messages: [],
					events: [
						{
							runId: "run",
							index: 1,
							agent: "worker",
							task: "review patch",
							title: "review patch",
							status: "failed",
							model: "faux/two",
							thinking: "high",
							error: "review failed",
							timestamp: 2,
						},
					],
				},
			],
		};

		let cancelled = false;
		const component = new SubagentRunViewComponent(
			{ result, events: result.results.flatMap((item) => item.events) },
			1,
			() => {
				cancelled = true;
			},
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Subagent review patch");
		expect(rendered).toContain("review failed");
		expect(rendered).toContain("tokens=9");
		expect(rendered).not.toContain("explorer output");

		component.handleInput("\u001b");
		expect(cancelled).toBe(true);
	});

	it("collapses repeated output events and shows tool details", () => {
		initTheme("dark");
		const data: SubagentDetailsData = {
			events: [
				{
					runId: "run",
					index: 0,
					agent: "explorer",
					task: "inspect /tmp",
					title: "inspect /tmp",
					status: "running",
					model: "faux/one",
					thinking: "off",
					outputSummary: "现在运行全面分析。编写临时脚本来收集数据。",
					timestamp: 1,
				},
				{
					runId: "run",
					index: 0,
					agent: "explorer",
					task: "inspect /tmp",
					title: "inspect /tmp",
					status: "running",
					model: "faux/one",
					thinking: "off",
					outputSummary: "现在运行全面分析。编写临时脚本来收集数据。",
					timestamp: 2,
				},
				{
					runId: "run",
					index: 0,
					agent: "explorer",
					task: "inspect /tmp",
					title: "inspect /tmp",
					status: "running",
					model: "faux/one",
					thinking: "off",
					currentTool: "read",
					currentToolArgs: '{"filePath":"/tmp/report.txt"}',
					timestamp: 3,
				},
				{
					runId: "run",
					index: 0,
					agent: "explorer",
					task: "inspect /tmp",
					title: "inspect /tmp",
					status: "running",
					model: "faux/one",
					thinking: "off",
					currentTool: "read",
					toolResultSummary: "file contents",
					timestamp: 4,
				},
			],
		};

		const component = new SubagentRunViewComponent(data, 0, () => {});
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/现在运行全面分析/g)).toHaveLength(1);
		expect(rendered).toContain("repeated 2x");
		expect(rendered).toContain('read {"filePath":"/tmp/report.txt"}');
		expect(rendered).toContain("result=file contents");
	});
});
