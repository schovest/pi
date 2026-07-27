import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface MockEditor {
	borderTitle?: string;
	borderTitleRight?: string;
}

function createSession(currentPrimaryAgent: string, modelId = "test-model"): AgentSession {
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
	};

	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
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
		expect(editor.borderTitleRight).toContain("agent-a");
		expect(editor.borderTitleRight).toContain("test-model");
	});

	it("updates the editor border eagerly when the primary agent changes", () => {
		const editor: MockEditor = {};
		const session = createSession("agent-a");
		const footer = new FooterComponent(session, createFooterData(), editor as never);

		footer.invalidate();
		expect(editor.borderTitleRight).toContain("agent-a");

		// Simulate switching the primary agent (what shift+tab / cycleAgent does)
		(session as unknown as { currentPrimaryAgent: string }).currentPrimaryAgent = "agent-b";
		footer.invalidate();

		expect(editor.borderTitleRight).toContain("agent-b");
		expect(editor.borderTitleRight).not.toContain("agent-a");
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
		expect(editor.borderTitleRight).toContain("agent-a");
	});

	it("keeps the editor border in sync during render()", () => {
		const editor: MockEditor = {};
		const footer = new FooterComponent(createSession("agent-a"), createFooterData(), editor as never);

		footer.render(120);

		expect(editor.borderTitleRight).toContain("agent-a");
	});
});
