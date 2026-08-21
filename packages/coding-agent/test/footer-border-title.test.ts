import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface MockEditor {
	borderTitle?: string;
	borderTitleRight?: string;
}

function createSession(
	currentPrimaryAgent: string,
	modelId = "test-model",
	// Mock overrides: partial object shapes (e.g. sessionManager, state) are
	// intentionally not checked against the real types — the assembly below
	// casts the whole mock anyway.
	overrides?: Record<string, unknown>,
): AgentSession {
	const session = {
		currentPrimaryAgent,
		state: {
			model: {
				id: modelId,
				provider: "test",
				contextWindow: 200_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionName: () => "",
			getEntries: () => [],
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
		getRunningSubagentCount: () => 0,
		backgroundProcessManager: { getRunningCount: () => 0 },
		modelRuntime: { isUsingOAuth: () => false },
		...overrides,
	};

	return session as unknown as AgentSession;
}

function createFooterData(availableProviderCount = 1): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => availableProviderCount,
		onBranchChange: () => () => {},
	};
}

describe("FooterComponent border title sync", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("pushes the current agent/model to the editor border on invalidate()", () => {
		const editor: MockEditor = {};
		const footer = new FooterComponent(createSession("agent-a"), createFooterData(), editor as never);

		footer.invalidate();

		expect(editor.borderTitle).toContain("/tmp/project");
		expect(editor.borderTitle).toContain("agent-a");
		// Model is now on the right side, not left
		expect(editor.borderTitleRight).toContain("test-model");
	});

	it("updates the editor border eagerly when the primary agent changes", () => {
		const editor: MockEditor = {};
		const session = createSession("agent-a");
		const footer = new FooterComponent(session, createFooterData(), editor as never);

		footer.invalidate();
		expect(editor.borderTitle).toContain("agent-a");

		// Simulate switching the primary agent (what shift+tab / cycleAgent does)
		(session as unknown as { currentPrimaryAgent: string }).currentPrimaryAgent = "agent-b";
		footer.invalidate();

		expect(editor.borderTitle).toContain("agent-b");
		expect(editor.borderTitle).not.toContain("agent-a");
	});

	it("does not overwrite the editor border while a custom footer is active", () => {
		const editor: MockEditor = {};
		const footer = new FooterComponent(createSession("agent-a"), createFooterData(), editor as never);

		footer.setActive(false);
		footer.invalidate();

		expect(editor.borderTitle).toBeUndefined();
		expect(editor.borderTitleRight).toBeUndefined();

		// Restoring the built-in footer re-enables syncing
		footer.setActive(true);
		footer.invalidate();
		expect(editor.borderTitle).toContain("agent-a");
	});

	it("keeps the editor border in sync during render()", () => {
		const editor: MockEditor = {};
		const footer = new FooterComponent(createSession("agent-a"), createFooterData(), editor as never);

		footer.render(120);

		expect(editor.borderTitle).toContain("agent-a");
		expect(editor.borderTitleRight).toContain("test-model");
	});

	it("places provider before model name (not before agent) when multiple providers exist", () => {
		const editor: MockEditor = {};
		const footer = new FooterComponent(
			createSession("coding", "deepseek-v4-flash"),
			createFooterData(2),
			editor as never,
		);

		// Agent now lives in getPathDisplay (after Π)
		const pathDisplay = footer.getPathDisplay();
		expect(pathDisplay).toContain("coding");

		const modelDisplay = footer.getModelEffortDisplay();
		// Provider slash prefix should appear before model name in getModelEffortDisplay
		expect(stripAnsi(modelDisplay)).toContain("test/deepseek-v4-flash");
	});

	it("renders the session name on the right side (model display), not the path", () => {
		const session = createSession("agent-a", "test-model", {
			sessionManager: {
				getCwd: () => "/tmp/project",
				getSessionName: () => "Dev Session",
				getEntries: () => [],
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(footer.getPathDisplay()).not.toContain("Dev Session");
		expect(footer.getModelEffortDisplay()).toContain("Dev Session");
	});

	it("drops the provider prefix when only a single provider is configured", () => {
		const session = createSession("agent-a", "deepseek-v4-flash", {
			state: {
				model: { id: "deepseek-v4-flash", provider: "deepseek", contextWindow: 200_000, reasoning: false },
				thinkingLevel: "off",
			},
		});

		const multiple = new FooterComponent(session, createFooterData(2));
		expect(stripAnsi(multiple.getModelEffortDisplay())).toContain("deepseek/deepseek-v4-flash");

		const single = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(single.getModelEffortDisplay())).not.toContain("deepseek/");
	});

	it("renders the thinking level in parens with the editor border color", () => {
		const session = createSession("agent-a", "test-model", {
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: true },
				thinkingLevel: "max",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const display = footer.getModelEffortDisplay();
		expect(stripAnsi(display)).toContain("(max)");
		// Level text carries the same color as the editor border line for that level
		expect(display).toContain(theme.getThinkingBorderColor("max")("max"));
		expect(stripAnsi(display)).not.toContain("·");
	});
});
