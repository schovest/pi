import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { CommandPaletteItem } from "./types.ts";

const DEFAULT_MAX_VISIBLE = 10;

export class CommandPaletteList implements Component {
	private items: CommandPaletteItem[] = [];
	private selectedIndex = 0;
	private maxVisible: number = DEFAULT_MAX_VISIBLE;

	setMaxVisible(maxVisible: number): void {
		this.maxVisible = maxVisible;
	}

	setItems(items: CommandPaletteItem[]): void {
		this.items = items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
	}

	getSelectedItem(): CommandPaletteItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	moveUp(): void {
		if (this.items.length === 0) return;
		this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : this.items.length - 1;
	}

	moveDown(): void {
		if (this.items.length === 0) return;
		this.selectedIndex = this.selectedIndex < this.items.length - 1 ? this.selectedIndex + 1 : 0;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		if (this.items.length === 0) {
			return [theme.fg("muted", "  No matching commands")];
		}

		const lines: string[] = [];
		const visible = Math.min(this.maxVisible, this.items.length);

		// Centered scroll: keep selected item centered in view
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(visible / 2), this.items.length - visible),
		);
		const endIndex = Math.min(startIndex + visible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			lines.push(this.renderItem(item, isSelected));
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			const info = theme.fg("muted", `  ${this.selectedIndex + 1}/${this.items.length}`);
			lines.push(info);
		}

		return lines;
	}

	private renderItem(item: CommandPaletteItem, isSelected: boolean): string {
		const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
		const labelText = isSelected ? theme.fg("accent", item.label) : item.label;
		const desc = item.description ? theme.fg("muted", item.description) : "";
		const keyHint = item.keybinding ? theme.fg("muted", item.keybinding) : "";
		return `${prefix}${labelText}  ${desc}${keyHint ? `  ${keyHint}` : ""}`;
	}
}
