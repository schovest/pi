import { Container, getKeybindings, Spacer, Text, truncateToWidth } from "@schovest/pi-tui";
import type { PrimaryAgentDefinition } from "../../../core/primary-agents/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

interface AgentSelectorOptions {
	agents: PrimaryAgentDefinition[];
	currentAgent: string;
	onSelect: (name: string) => void;
	onClose: () => void;
}

export class AgentSelectorComponent extends Container {
	private agents: PrimaryAgentDefinition[];
	private currentAgent: string;
	private selectedIndex = 0;
	private onSelect: (name: string) => void;
	private onClose: () => void;

	constructor(options: AgentSelectorOptions) {
		super();
		this.agents = options.agents;
		this.currentAgent = options.currentAgent;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + 1);
			this.rebuild();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "Enter") {
			const selected = this.agents[this.selectedIndex];
			if (selected) {
				this.onSelect(selected.name);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onClose();
		}
	}

	private rebuild(): void {
		this.clear();
		this.selectedIndex = this.agents.length === 0 ? 0 : Math.min(this.selectedIndex, this.agents.length - 1);
		const selected = this.agents[this.selectedIndex];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Switch Agent Role")), 1, 0));
		this.addChild(new Spacer(1));

		if (this.agents.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No primary agent definitions available."), 1, 0));
		} else {
			for (let index = 0; index < this.agents.length; index++) {
				const agent = this.agents[index];
				const pointer = index === this.selectedIndex ? theme.fg("accent", "-> ") : "   ";
				const current = agent.name === this.currentAgent ? theme.fg("success", " (active)") : "";
				const scope = theme.fg("muted", `[${agent.scope}]`);
				const desc = theme.fg("muted", agent.description);
				this.addChild(new Text(`${pointer}${agent.name}${current} ${scope} ${desc}`, 1, 0));
			}
		}

		this.addChild(new Spacer(1));
		if (selected) {
			this.addChild(new Text(theme.bold("Details"), 1, 0));
			this.addChild(new Text(`${theme.bold("Description")} ${selected.description}`, 1, 0));
			const promptSummary = selected.systemPrompt
				? selected.systemPrompt.replace(/\s+/g, " ").trim().slice(0, 120) +
					(selected.systemPrompt.length > 120 ? "..." : "")
				: "(default system prompt)";
			this.addChild(new Text(`${theme.bold("Prompt")} ${promptSummary}`, 1, 0));
			const tools = selected.includedTools
				? `only: ${selected.includedTools.join(", ")}`
				: selected.excludedTools
					? `all except: ${selected.excludedTools.join(", ")}`
					: "all tools";
			this.addChild(new Text(`${theme.bold("Tools")} ${tools}`, 1, 0));
			this.addChild(new Text(`${theme.bold("Model")} ${selected.model ?? "default"}`, 1, 0));
			this.addChild(new Text(`${theme.bold("Thinking")} ${selected.thinking ?? "default"}`, 1, 0));
			this.addChild(new Spacer(1));
		}

		this.addChild(
			new Text(
				`${rawKeyHint("↑↓/j/k", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "close")}`,
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(line, width, "..."));
	}
}
