import { Container, type Focusable, getKeybindings, Spacer, Text, type TUI } from "@schovest/pi-tui";
import type { BackgroundProcess, BackgroundProcessManager } from "../../../core/background-process-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface BackgroundProcessSelectorOptions {
	manager: BackgroundProcessManager;
	tui: TUI;
	onClose: () => void;
	onStatus?: (message: string) => void;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m${remainingSeconds}s`;
}

/**
 * Background process management overlay.
 *
 * Replaces the editor when active (via showSelector). Lists all background
 * processes with their status. Supports:
 *   - Up/Down: navigate
 *   - Enter:   view full output
 *   - k:       kill running process
 *   - Escape:  close
 */
export class BackgroundProcessSelector extends Container implements Focusable {
	private readonly manager: BackgroundProcessManager;
	private readonly tui: TUI;
	private readonly onClose: () => void;
	private readonly onStatus?: (message: string) => void;
	private processes: BackgroundProcess[] = [];
	private selectedIndex = 0;
	private viewMode: "list" | "output" = "list";
	private renderTimer: NodeJS.Timeout | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(options: BackgroundProcessSelectorOptions) {
		super();
		this.manager = options.manager;
		this.tui = options.tui;
		this.onClose = options.onClose;
		this.onStatus = options.onStatus;
		this.refresh();
		// Auto-refresh every second to update running durations.
		this.renderTimer = setInterval(() => {
			if (this.viewMode === "list") {
				this.refresh();
			}
		}, 1000);
	}

	private refresh(): void {
		this.processes = this.manager.getAll().sort((a, b) => b.startedAt - a.startedAt);
		if (this.selectedIndex >= this.processes.length) {
			this.selectedIndex = Math.max(0, this.processes.length - 1);
		}
		this.rebuild();
		this.tui.requestRender();
	}

	private rebuild(): void {
		this.clear();

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Background Processes")), 1, 0));

		if (this.viewMode === "output") {
			this.rebuildOutputView();
		} else {
			this.rebuildListView();
		}

		this.addChild(new DynamicBorder());
	}

	private rebuildListView(): void {
		if (this.processes.length === 0) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "No background processes."), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
			return;
		}

		this.addChild(new Spacer(1));
		this.processes.forEach((proc, i) => {
			const selected = i === this.selectedIndex;
			const prefix = selected ? "▶ " : "  ";
			const statusText =
				proc.status === "running"
					? theme.fg("accent", "running")
					: proc.exitCode === 0
						? theme.fg("success", `exit ${proc.exitCode}`)
						: theme.fg("error", `exit ${proc.exitCode}`);
			const duration =
				proc.status === "running"
					? formatDuration(Date.now() - proc.startedAt)
					: proc.endedAt
						? formatDuration(proc.endedAt - proc.startedAt)
						: "";
			const truncatedCommand = proc.command.length > 50 ? `${proc.command.slice(0, 47)}...` : proc.command;
			const line = `${prefix}${statusText} ${theme.fg("muted", `[${proc.pid}] ${duration}`)} ${truncatedCommand}`;
			this.addChild(new Text(line, 0, 0));
		});

		this.addChild(new Spacer(1));
		const hints: string[] = [
			keyHint("tui.select.up", "↑"),
			keyHint("tui.select.down", "↓"),
			keyHint("tui.select.confirm", "view"),
			`${keyHint("app.backgroundProcesses", "k")} kill`,
			keyHint("tui.select.cancel", "close"),
		];
		this.addChild(new Text(theme.fg("muted", hints.join("  ")), 1, 0));
	}

	private rebuildOutputView(): void {
		const proc = this.processes[this.selectedIndex];
		if (!proc) {
			this.viewMode = "list";
			this.rebuildListView();
			return;
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("toolTitle", `$ ${proc.command}`), 0, 0));
		const statusText =
			proc.status === "running" ? theme.fg("accent", "running") : theme.fg("muted", `exit code ${proc.exitCode}`);
		this.addChild(new Text(theme.fg("muted", `PID ${proc.pid} · ${statusText}`), 0, 0));
		this.addChild(new Spacer(1));

		const snapshot = proc.output.snapshot({ persistIfTruncated: true });
		const lines = snapshot.content.split("\n");
		const maxDisplayLines = 20;
		const displayLines = lines.slice(-maxDisplayLines);
		if (lines.length > maxDisplayLines) {
			this.addChild(
				new Text(theme.fg("muted", `... (${lines.length - maxDisplayLines} earlier lines hidden)`), 0, 0),
			);
		}
		for (const line of displayLines) {
			this.addChild(new Text(theme.fg("toolOutput", line), 0, 0));
		}

		if (snapshot.truncation.truncated && snapshot.fullOutputPath) {
			this.addChild(new Text(theme.fg("warning", `Full output: ${snapshot.fullOutputPath}`), 0, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `(${keyHint("tui.select.cancel", "back to list")})`), 1, 0));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.viewMode === "output") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.viewMode = "list";
				this.rebuild();
			}
			return;
		}

		if (kb.matches(data, "tui.select.cancel")) {
			this.destroy();
			this.onClose();
			return;
		}

		if (this.processes.length === 0) return;

		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
			return;
		}

		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.processes.length - 1, this.selectedIndex + 1);
			this.rebuild();
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			if (this.processes[this.selectedIndex]) {
				this.viewMode = "output";
				this.rebuild();
			}
			return;
		}

		// 'k' to kill
		if (data === "k") {
			const proc = this.processes[this.selectedIndex];
			if (proc && proc.status === "running") {
				this.manager.kill(proc.id);
				this.onStatus?.(`Killed background process: ${proc.command}`);
				setTimeout(() => this.refresh(), 100);
			}
		}
	}

	destroy(): void {
		if (this.renderTimer) {
			clearInterval(this.renderTimer);
			this.renderTimer = undefined;
		}
	}
}
