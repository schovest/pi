import type { Focusable } from "@earendil-works/pi-tui";
import { Container, Input, type KeybindingsManager, Spacer } from "@earendil-works/pi-tui";
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

	constructor(registry: CommandRegistry, keybindings: KeybindingsManager, callbacks: CommandPaletteCallbacks) {
		super();
		this.registry = registry;
		this.keybindings = keybindings;
		this.callbacks = callbacks;

		this.searchInput = new Input();
		this.list = new CommandPaletteList();

		this.filteredItems = registry.getAll();
		this.list.setItems(this.filteredItems);

		this.addChild(new DynamicBorder());
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			this.list.moveUp();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down")) {
			this.list.moveDown();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			const selected = this.list.getSelectedItem();
			if (selected) {
				this.callbacks.onSelect(selected);
			}
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.callbacks.onCancel();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterItems();
	}

	private filterItems(): void {
		const query = this.searchInput.getValue();
		this.filteredItems = this.registry.search(query);
		this.list.setItems(this.filteredItems);
	}
}
