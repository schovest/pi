import { fuzzyFilter } from "@schovest/pi-tui";
import type { CommandPaletteItem } from "./types.ts";

export class CommandRegistry {
	private items = new Map<string, CommandPaletteItem>();

	register(item: CommandPaletteItem): void {
		this.items.set(item.id, item);
	}

	unregister(id: string): void {
		this.items.delete(id);
	}

	getAll(): CommandPaletteItem[] {
		return [...this.items.values()].filter((item) => {
			if (item.visible === undefined) return true;
			if (typeof item.visible === "function") return item.visible();
			return item.visible;
		});
	}

	search(query: string): CommandPaletteItem[] {
		const all = this.getAll();
		if (!query) return all;
		return fuzzyFilter(
			all,
			query,
			(item) =>
				`${item.label} ${item.description ?? ""} ${(item.keywords ?? []).join(" ")} ${item.keybinding ?? ""}`,
		);
	}
}
