import { Container, type Focusable, getKeybindings, Input, Spacer, Text } from "@schovest/pi-tui";
import type {
	CodexPluginManager,
	CodexPluginSearchResult,
	ConfiguredCodexPlugin,
} from "../../../core/codex-plugin-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type PluginScope = "user" | "project";
type View =
	| "main"
	| "search"
	| "searchResults"
	| "installScope"
	| "installed"
	| "installedAction"
	| "marketplaces"
	| "marketplaceAction"
	| "addMarketplaceName"
	| "addMarketplaceSource";

type CodexPluginManagerLike = Pick<
	CodexPluginManager,
	| "addMarketplace"
	| "install"
	| "listConfiguredPlugins"
	| "listMarketplaces"
	| "remove"
	| "removeMarketplace"
	| "searchMarketplaces"
	| "update"
>;

interface CodexPluginManagerComponentOptions {
	pluginManager: CodexPluginManagerLike;
	settingsManager: Pick<SettingsManager, "flush">;
	onReload: () => Promise<void>;
	onClose: () => void;
	onStatus?: (message: string) => void;
	onError?: (message: string) => void;
	tui: { requestRender(force?: boolean): void };
}

interface MarketplaceItem {
	name: string;
	source: string;
}

export class CodexPluginManagerComponent extends Container implements Focusable {
	private readonly pluginManager: CodexPluginManagerLike;
	private readonly settingsManager: Pick<SettingsManager, "flush">;
	private readonly onReload: () => Promise<void>;
	private readonly onClose: () => void;
	private readonly onStatus?: (message: string) => void;
	private readonly onError?: (message: string) => void;
	private readonly tui: { requestRender(force?: boolean): void };
	private readonly input = new Input();
	private view: View = "main";
	private selectedIndex = 0;
	private searchResults: CodexPluginSearchResult[] = [];
	private selectedSearchResult: CodexPluginSearchResult | undefined;
	private installedPlugins: ConfiguredCodexPlugin[] = [];
	private selectedPlugin: ConfiguredCodexPlugin | undefined;
	private marketplaces: MarketplaceItem[] = [];
	private selectedMarketplace: MarketplaceItem | undefined;
	private pendingMarketplaceName = "";
	private statusMessage: string | undefined;
	private busy = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.isInputView();
	}

	constructor(options: CodexPluginManagerComponentOptions) {
		super();
		this.pluginManager = options.pluginManager;
		this.settingsManager = options.settingsManager;
		this.onReload = options.onReload;
		this.onClose = options.onClose;
		this.onStatus = options.onStatus;
		this.onError = options.onError;
		this.tui = options.tui;
		this.input.onSubmit = (value) => {
			void this.handleInputSubmit(value);
		};
		this.input.onEscape = () => this.goBack();
		this.refresh();
	}

	async installSearchResult(result: CodexPluginSearchResult, scope: PluginScope): Promise<void> {
		const installed = await this.pluginManager.install(`${result.name}@${result.marketplace}`, {
			local: scope === "project",
		});
		await this.afterMutation(`Installed plugin ${installed.name}`);
	}

	async removePlugin(plugin: ConfiguredCodexPlugin): Promise<void> {
		const removed = this.pluginManager.remove(plugin.name, { local: plugin.scope === "project" });
		if (!removed) {
			this.setStatus(`No matching plugin found for ${plugin.name}`, true);
			return;
		}
		await this.afterMutation(`Removed plugin ${plugin.name}`);
	}

	async updatePlugins(plugin?: ConfiguredCodexPlugin): Promise<void> {
		await this.pluginManager.update(plugin?.name);
		await this.afterMutation(plugin ? `Updated plugin ${plugin.name}` : "Updated plugins");
	}

	handleInput(keyData: string): void {
		if (this.busy) {
			return;
		}
		if (this.isInputView()) {
			this.input.handleInput(keyData);
			this.tui.requestRender();
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.goBack();
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			void this.confirmSelection();
		}
	}

	private async afterMutation(message: string): Promise<void> {
		await this.settingsManager.flush();
		await this.onReload();
		this.setStatus(message);
		this.refreshCurrentData();
		this.refresh();
	}

	private refreshCurrentData(): void {
		this.installedPlugins = this.pluginManager.listConfiguredPlugins();
		this.marketplaces = this.pluginManager.listMarketplaces();
	}

	private setStatus(message: string, error = false): void {
		this.statusMessage = message;
		if (error) {
			this.onError?.(message);
		} else {
			this.onStatus?.(message);
		}
	}

	private async handleInputSubmit(value: string): Promise<void> {
		if (this.view === "search") {
			await this.loadSearchResults(value);
			return;
		}
		if (this.view === "addMarketplaceName") {
			const name = value.trim();
			if (!name) {
				this.setStatus("Marketplace name is required", true);
				this.refresh();
				return;
			}
			this.pendingMarketplaceName = name;
			this.input.setValue("");
			this.view = "addMarketplaceSource";
			this.refresh();
			return;
		}
		if (this.view === "addMarketplaceSource") {
			const source = value.trim();
			if (!source) {
				this.setStatus("Marketplace source is required", true);
				this.refresh();
				return;
			}
			this.pluginManager.addMarketplace(this.pendingMarketplaceName, source);
			this.view = "marketplaces";
			this.input.setValue("");
			await this.afterMutation(`Added plugin marketplace ${this.pendingMarketplaceName}`);
		}
	}

	private async loadSearchResults(query: string): Promise<void> {
		this.busy = true;
		this.statusMessage = "Searching plugin marketplaces...";
		this.refresh();
		try {
			this.searchResults = await this.pluginManager.searchMarketplaces(query.trim() || undefined);
			this.selectedIndex = 0;
			this.view = "searchResults";
			this.statusMessage =
				this.searchResults.length === 0 ? "No matching plugins found." : `${this.searchResults.length} plugin(s)`;
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : String(error), true);
		} finally {
			this.busy = false;
			this.refresh();
		}
	}

	private async confirmSelection(): Promise<void> {
		if (this.view === "main") {
			await this.confirmMain();
		} else if (this.view === "searchResults") {
			const result = this.searchResults[this.selectedIndex];
			if (result) {
				this.selectedSearchResult = result;
				this.selectedIndex = 0;
				this.view = "installScope";
				this.refresh();
			}
		} else if (this.view === "installScope") {
			const result = this.selectedSearchResult;
			if (result) {
				if (this.selectedIndex === 2) {
					this.view = "searchResults";
				} else {
					this.view = "searchResults";
					await this.runBusy(() =>
						this.installSearchResult(result, this.selectedIndex === 0 ? "user" : "project"),
					);
				}
				this.refresh();
			}
		} else if (this.view === "installed") {
			const plugin = this.installedPlugins[this.selectedIndex];
			if (plugin) {
				this.selectedPlugin = plugin;
				this.selectedIndex = 0;
				this.view = "installedAction";
				this.refresh();
			}
		} else if (this.view === "installedAction") {
			await this.confirmInstalledAction();
		} else if (this.view === "marketplaces") {
			if (this.selectedIndex === 0) {
				this.input.setValue("");
				this.view = "addMarketplaceName";
			} else {
				const marketplace = this.marketplaces[this.selectedIndex - 1];
				if (marketplace) {
					this.selectedMarketplace = marketplace;
					this.selectedIndex = 0;
					this.view = "marketplaceAction";
				}
			}
			this.refresh();
		} else if (this.view === "marketplaceAction") {
			await this.confirmMarketplaceAction();
		}
	}

	private async confirmMain(): Promise<void> {
		switch (this.selectedIndex) {
			case 0:
				this.input.setValue("");
				this.view = "search";
				this.refresh();
				break;
			case 1:
				this.installedPlugins = this.pluginManager.listConfiguredPlugins();
				this.selectedIndex = 0;
				this.view = "installed";
				this.refresh();
				break;
			case 2:
				this.marketplaces = this.pluginManager.listMarketplaces();
				this.selectedIndex = 0;
				this.view = "marketplaces";
				this.refresh();
				break;
			case 3:
				await this.runBusy(() => this.updatePlugins());
				break;
			default:
				this.onClose();
		}
	}

	private async confirmInstalledAction(): Promise<void> {
		const plugin = this.selectedPlugin;
		if (!plugin) {
			this.view = "installed";
			this.refresh();
			return;
		}
		if (this.selectedIndex === 0) {
			await this.runBusy(() => this.updatePlugins(plugin));
			this.view = "installed";
		} else if (this.selectedIndex === 1) {
			await this.runBusy(() => this.removePlugin(plugin));
			this.view = "installed";
		} else {
			this.view = "installed";
		}
		this.refresh();
	}

	private async confirmMarketplaceAction(): Promise<void> {
		const marketplace = this.selectedMarketplace;
		if (!marketplace) {
			this.view = "marketplaces";
			this.refresh();
			return;
		}
		if (this.selectedIndex === 0) {
			const removed = this.pluginManager.removeMarketplace(marketplace.name);
			if (removed) {
				await this.afterMutation(`Removed plugin marketplace ${marketplace.name}`);
			} else {
				this.setStatus(`No matching plugin marketplace found for ${marketplace.name}`, true);
			}
		}
		this.view = "marketplaces";
		this.refresh();
	}

	private async runBusy(action: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.refresh();
		try {
			await action();
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : String(error), true);
		} finally {
			this.busy = false;
			this.refresh();
		}
	}

	private goBack(): void {
		if (this.view === "main") {
			this.onClose();
			return;
		}
		if (this.view === "search" || this.view === "installed" || this.view === "marketplaces") {
			this.view = "main";
		} else if (this.view === "addMarketplaceSource") {
			this.view = "addMarketplaceName";
		} else if (this.view === "addMarketplaceName" || this.view === "marketplaceAction") {
			this.view = "marketplaces";
		} else if (this.view === "installedAction") {
			this.view = "installed";
		} else {
			this.view = "search";
		}
		this.selectedIndex = 0;
		this.refresh();
	}

	private moveSelection(delta: number): void {
		const count = this.getSelectionCount();
		if (count === 0) {
			return;
		}
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.refresh();
	}

	private getSelectionCount(): number {
		switch (this.view) {
			case "main":
				return this.mainItems().length;
			case "searchResults":
				return this.searchResults.length;
			case "installScope":
				return 3;
			case "installed":
				return this.installedPlugins.length;
			case "installedAction":
				return 3;
			case "marketplaces":
				return this.marketplaces.length + 1;
			case "marketplaceAction":
				return 2;
			default:
				return 0;
		}
	}

	private isInputView(): boolean {
		return this.view === "search" || this.view === "addMarketplaceName" || this.view === "addMarketplaceSource";
	}

	private refresh(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", "Codex Plugins"), 0, 0));
		this.addChild(new Spacer(1));

		if (this.view === "main") {
			this.renderMenu(this.mainItems());
		} else if (this.view === "search") {
			this.addChild(new Text("Search marketplace catalog", 0, 0));
			this.addChild(this.input);
		} else if (this.view === "searchResults") {
			this.renderSearchResults();
		} else if (this.view === "installScope") {
			this.renderMenu(["User", "Project", "Back"]);
		} else if (this.view === "installed") {
			this.renderInstalled();
		} else if (this.view === "installedAction") {
			this.renderMenu(["Update", "Remove", "Back"]);
		} else if (this.view === "marketplaces") {
			this.renderMarketplaces();
		} else if (this.view === "marketplaceAction") {
			this.renderMenu(["Remove", "Back"]);
		} else if (this.view === "addMarketplaceName") {
			this.addChild(new Text("Marketplace name", 0, 0));
			this.addChild(this.input);
		} else if (this.view === "addMarketplaceSource") {
			this.addChild(new Text(`Source for ${this.pendingMarketplaceName}`, 0, 0));
			this.addChild(this.input);
		}

		this.addChild(new Spacer(1));
		if (this.statusMessage) {
			this.addChild(new Text(theme.fg("muted", this.statusMessage), 0, 0));
		}
		this.addChild(
			new Text(
				theme.fg("dim", `${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "back")}`),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
		this.input.focused = this.focused && this.isInputView();
		this.tui.requestRender();
	}

	private mainItems(): string[] {
		return ["Search marketplace", "Installed plugins", "Marketplaces", "Update all", "Close"];
	}

	private renderMenu(items: string[]): void {
		for (const [index, item] of items.entries()) {
			const prefix = index === this.selectedIndex ? ">" : " ";
			this.addChild(new Text(`${prefix} ${item}`, 0, 0));
		}
	}

	private renderSearchResults(): void {
		if (this.searchResults.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No matching plugins found."), 0, 0));
			return;
		}
		for (const [index, result] of this.searchResults.entries()) {
			const prefix = index === this.selectedIndex ? ">" : " ";
			const installed = result.installed ? theme.fg("success", " installed") : "";
			this.addChild(
				new Text(
					`${prefix} ${result.name}@${result.marketplace} ${theme.fg("dim", result.source)}${installed}`,
					0,
					0,
				),
			);
		}
	}

	private renderInstalled(): void {
		this.installedPlugins = this.pluginManager.listConfiguredPlugins();
		if (this.installedPlugins.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No codex plugins installed."), 0, 0));
			return;
		}
		for (const [index, plugin] of this.installedPlugins.entries()) {
			const prefix = index === this.selectedIndex ? ">" : " ";
			const enabled = plugin.enabled ? "" : " disabled";
			this.addChild(
				new Text(`${prefix} ${plugin.name} ${theme.fg("dim", `${plugin.scope}${enabled} ${plugin.source}`)}`, 0, 0),
			);
		}
	}

	private renderMarketplaces(): void {
		this.marketplaces = this.pluginManager.listMarketplaces();
		const addPrefix = this.selectedIndex === 0 ? ">" : " ";
		this.addChild(new Text(`${addPrefix} Add marketplace`, 0, 0));
		for (const [index, marketplace] of this.marketplaces.entries()) {
			const itemIndex = index + 1;
			const prefix = itemIndex === this.selectedIndex ? ">" : " ";
			this.addChild(new Text(`${prefix} ${marketplace.name} ${theme.fg("dim", marketplace.source)}`, 0, 0));
		}
	}
}
