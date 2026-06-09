import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "../src/core/subagents/types.ts";
import { SubagentsPanelComponent } from "../src/modes/interactive/components/subagents-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function render(component: SubagentsPanelComponent): string {
	return stripAnsi(component.render(160).join("\n"));
}

const subagents: SubagentDefinition[] = [
	{
		name: "explorer",
		description: "Builtin explorer",
		prompt: "Fast parallel search for discovery. Returns locations and summaries.",
		scope: "builtin",
		tools: ["read", "grep"],
	},
	{
		name: "architect",
		description: "User architect",
		prompt: "Design the implementation plan.",
		scope: "user",
		sourcePath: "/home/test/.pi/agent/agents/architect.md",
		model: "openai/gpt-5",
		thinking: "high",
		tools: ["read", "write"],
	},
	{
		name: "auditor",
		description: "Project auditor",
		prompt: "Review the patch for regressions.",
		scope: "project",
		sourcePath: "/repo/.pi/agents/auditor.md",
		tools: ["read"],
	},
];

describe("SubagentsPanelComponent", () => {
	it("renders builtin, user, and project agent definitions with locations", () => {
		initTheme("dark");
		const component = new SubagentsPanelComponent({
			subagents,
			onClose: () => {},
		});

		const text = render(component);

		expect(text).toContain("Subagents");
		expect(text).toContain("explorer");
		expect(text).toContain("builtin");
		expect(text).toContain("Builtin definitions are compiled into this Pi distribution.");
		expect(text).toContain("architect");
		expect(text).toContain("user");
		expect(text).toContain("/home/test/.pi/agent/agents/architect.md");
		expect(text).toContain("auditor");
		expect(text).toContain("project");
		expect(text).toContain("/repo/.pi/agents/auditor.md");
	});

	it("shows lifecycle status, task, tool, tokens, error, and recent events", () => {
		initTheme("dark");
		const component = new SubagentsPanelComponent({
			subagents,
			subagentDetails: {
				events: [
					{
						runId: "run",
						index: 0,
						agent: "explorer",
						task: "inspect files",
						title: "inspect files",
						status: "pending",
						timestamp: 1,
					},
					{
						runId: "run",
						index: 0,
						agent: "explorer",
						task: "inspect files",
						title: "inspect files",
						status: "running",
						currentTool: "grep",
						currentToolArgs: '{"pattern":"TODO"}',
						timestamp: 2,
					},
					{
						runId: "run",
						index: 0,
						agent: "explorer",
						task: "inspect files",
						title: "inspect files",
						status: "failed",
						currentTool: "grep",
						usage: {
							input: 10,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 30,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						error: "grep failed",
						timestamp: 3,
					},
				],
			},
			onClose: () => {},
		});

		const text = render(component);

		expect(text).toContain("Status failed");
		expect(text).toContain("Task inspect files");
		expect(text).toContain('Tool grep {"pattern":"TODO"}');
		expect(text).toContain("Tokens 30");
		expect(text).toContain("Error grep failed");
		expect(text).toContain("pending");
		expect(text).toContain("running tool=grep");
		expect(text).toContain("failed tool=grep error=grep failed tokens=30");
	});

	it("shows a clear empty run state when no run exists for the selected agent", () => {
		initTheme("dark");
		const component = new SubagentsPanelComponent({
			subagents,
			onClose: () => {},
		});

		expect(render(component)).toContain("No subagent run captured for explorer.");
	});

	it("updates details when navigating between agents", () => {
		initTheme("dark");
		const component = new SubagentsPanelComponent({
			subagents,
			onClose: () => {},
		});

		expect(render(component)).toContain("Fast parallel search for discovery. Returns locations and summaries.");

		component.handleInput("j");
		const text = render(component);

		expect(text).toContain("Design the implementation plan.");
		expect(text).toContain("Model openai/gpt-5");
		expect(text).toContain("Thinking high");
	});
});
