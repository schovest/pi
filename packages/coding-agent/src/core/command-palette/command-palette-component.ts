import type { Focusable, Terminal } from "@schovest/pi-tui";
import { Container, Input, type KeybindingsManager, Spacer } from "@schovest/pi-tui";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { CommandPaletteList } from "./command-palette-list.ts";
import type { CommandRegistry } from "./command-registry.ts";
import type { CommandPaletteCallbacks, CommandPaletteItem } from "./types.ts";

export class CommandPaletteComponent extends Container implements Focusable {
	private _focused = false;
	private filteredItems: CommandPaletteItem[] = [];
	private searchInput: Input;
	private list: CommandPaletteList;
	private registry: CommandRegistry;
	private keybindings: KeybindingsManager;
	private callbacks: CommandPaletteCallbacks;
	private terminal: Terminal;
	private maxHeightPercent: number;

	/** Non-list children for chrome measurement */
	private chromeChildren: Array<{ render: (width: number) => string[] }>;

	constructor(
		registry: CommandRegistry,
		keybindings: KeybindingsManager,
		callbacks: CommandPaletteCallbacks,
		terminal: Terminal,
		maxHeightPercent: number = 50,
	) {
		super();
		this.registry = registry;
		this.keybindings = keybindings;
		this.callbacks = callbacks;
		this.terminal = terminal;
		this.maxHeightPercent = maxHeightPercent;

		this.searchInput = new Input();
		this.list = new CommandPaletteList();

		this.filteredItems = registry.getAll();
		this.list.setItems(this.filteredItems);

		const topBorder = new DynamicBorder();
		const topSpacer = new Spacer(1);
		const bottomSpacer = new Spacer(1);
		const bottomBorder = new DynamicBorder();

		this.chromeChildren = [topBorder, this.searchInput, topSpacer, bottomSpacer, bottomBorder];

		this.addChild(topBorder);
		this.addChild(this.searchInput);
		this.addChild(topSpacer);
		this.addChild(this.list);
		this.addChild(bottomSpacer);
		this.addChild(bottomBorder);
	}

	render(width: number): string[] {
		const maxOverlayHeight = Math.floor((this.terminal.rows * this.maxHeightPercent) / 100);
		let chromeLines = 0;
		for (const child of this.chromeChildren) {
			chromeLines += child.render(width).length;
		}
		const listMaxVisible = Math.max(1, maxOverlayHeight - chromeLines);
		this.list.setMaxVisible(listMaxVisible);
		return super.render(width);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(keyData: string): boolean {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			this.list.moveUp();
			return true;
		}
		if (this.keybindings.matches(keyData, "tui.select.down")) {
			this.list.moveDown();
			return true;
		}
		if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			const selected = this.list.getSelectedItem();
			if (selected) {
				this.callbacks.onSelect(selected);
			}
			return true;
		}
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.callbacks.onCancel();
			return true;
		}

		this.searchInput.handleInput(keyData);
		this.filterItems();
		return false;
	}

	private filterItems(): void {
		const query = this.searchInput.getValue();
		this.filteredItems = this.registry.search(query);
		this.list.setItems(this.filteredItems);
	}
}
