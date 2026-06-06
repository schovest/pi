import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { CommandPaletteItem } from "./types.ts";

const MAX_VISIBLE = 10;

export class CommandPaletteList extends Container {
	private items: CommandPaletteItem[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;

	setItems(items: CommandPaletteItem[]): void {
		this.items = items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, items.length - MAX_VISIBLE)));
		this.updateView();
	}

	getSelectedItem(): CommandPaletteItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	moveUp(): void {
		if (this.items.length === 0) return;
		this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : this.items.length - 1;
		this.adjustScroll();
		this.updateView();
	}

	moveDown(): void {
		if (this.items.length === 0) return;
		this.selectedIndex = this.selectedIndex < this.items.length - 1 ? this.selectedIndex + 1 : 0;
		this.adjustScroll();
		this.updateView();
	}

	private adjustScroll(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
		}
	}

	private updateView(): void {
		this.clear();

		if (this.items.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No matching commands")));
			return;
		}

		const endIndex = Math.min(this.scrollOffset + MAX_VISIBLE, this.items.length);

		for (let i = this.scrollOffset; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			this.addChild(new Text(this.renderItem(item, isSelected)));
		}

		if (this.scrollOffset > 0 || endIndex < this.items.length) {
			this.addChild(new Spacer(1));
			const info = theme.fg("muted", `  ${this.selectedIndex + 1}/${this.items.length}`);
			this.addChild(new Text(info));
		}
	}

	private renderItem(item: CommandPaletteItem, isSelected: boolean): string {
		const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
		const labelText = isSelected ? theme.fg("accent", item.label) : item.label;
		const desc = item.description ? theme.fg("muted", item.description) : "";
		const keyHint = item.keybinding ? theme.fg("muted", item.keybinding) : "";
		return `${prefix}${labelText}  ${desc}${keyHint ? `  ${keyHint}` : ""}`;
	}
}
