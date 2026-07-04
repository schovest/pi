import type { KeyId } from "@schovest/pi-tui";

export type CommandCategory =
	| "navigation"
	| "model"
	| "session"
	| "settings"
	| "tools"
	| "slash"
	| "extension"
	| "skill";

export interface CommandPaletteItem {
	id: string;
	label: string;
	description?: string;
	category: CommandCategory;
	keywords?: string[];
	keybinding?: KeyId;
	handler: () => void | Promise<void>;
	visible?: boolean | (() => boolean);
}

export interface CommandPaletteCallbacks {
	onSelect: (item: CommandPaletteItem) => void;
	onCancel: () => void;
}
