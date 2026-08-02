import { Container } from "@schovest/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CodexPluginSearchResult, ConfiguredCodexPlugin } from "../src/core/codex-plugin-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { CodexPluginManagerComponent } from "../src/modes/interactive/components/codex-plugin-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type CodexPluginsCommandContext = {
	editor: { setText: (text: string) => void };
	showCodexPluginsManager: () => void;
};

type InteractiveModePrototype = {
	handleCodexPluginsCommand(this: CodexPluginsCommandContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

beforeAll(() => {
	initTheme("dark");
});

describe("InteractiveMode /codex-plugin", () => {
	it("registers /codex-plugin as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "codex-plugin")).toBe(true);
	});

	it("opens the codex plugin manager and clears the editor", () => {
		const setText = vi.fn();
		const showCodexPluginsManager = vi.fn();

		interactiveModePrototype.handleCodexPluginsCommand.call({
			editor: { setText },
			showCodexPluginsManager,
		});

		expect(setText).toHaveBeenCalledWith("");
		expect(showCodexPluginsManager).toHaveBeenCalledTimes(1);
	});
});

describe("CodexPluginManagerComponent mutations", () => {
	it("flushes settings and reloads after installing a marketplace result", async () => {
		const install = vi.fn(async () => ({
			name: "superpowers",
			source: "https://github.com/example/superpowers",
			marketplace: "claude",
			enabled: true,
			scope: "user" as const,
		}));
		const flush = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const status = vi.fn();
		const result: CodexPluginSearchResult = {
			name: "superpowers",
			marketplace: "claude",
			source: "https://github.com/example/superpowers",
			installed: false,
		};
		const component = new CodexPluginManagerComponent({
			pluginManager: {
				listConfiguredPlugins: () => [],
				listMarketplaces: () => [],
				searchMarketplaces: async () => [],
				install,
				remove: () => false,
				update: async () => {},
				addMarketplace: () => {},
				removeMarketplace: () => false,
			},
			settingsManager: { flush },
			onReload: reload,
			onClose: () => {},
			onStatus: status,
			tui: { requestRender: () => {} },
		});

		await component.installSearchResult(result, "user");

		expect(install).toHaveBeenCalledWith("superpowers@claude", { local: false });
		expect(flush).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(status).toHaveBeenCalledWith("Installed plugin superpowers");
	});

	it("uses the plugin scope when removing an installed plugin", async () => {
		const remove = vi.fn(() => true);
		const flush = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const plugin: ConfiguredCodexPlugin = {
			name: "superpowers",
			source: "https://github.com/example/superpowers",
			enabled: true,
			scope: "project",
		};
		const component = new CodexPluginManagerComponent({
			pluginManager: {
				listConfiguredPlugins: () => [plugin],
				listMarketplaces: () => [],
				searchMarketplaces: async () => [],
				install: async () => plugin,
				remove,
				update: async () => {},
				addMarketplace: () => {},
				removeMarketplace: () => false,
			},
			settingsManager: { flush },
			onReload: reload,
			onClose: () => {},
			tui: { requestRender: () => {} },
		});

		await component.removePlugin(plugin);

		expect(remove).toHaveBeenCalledWith("superpowers", { local: true });
		expect(flush).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("flushes settings and reloads after updating plugins", async () => {
		const update = vi.fn(async () => {});
		const flush = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const component = new CodexPluginManagerComponent({
			pluginManager: {
				listConfiguredPlugins: () => [],
				listMarketplaces: () => [],
				searchMarketplaces: async () => [],
				install: async () => ({
					name: "superpowers",
					source: "https://github.com/example/superpowers",
					enabled: true,
					scope: "user" as const,
				}),
				remove: () => false,
				update,
				addMarketplace: () => {},
				removeMarketplace: () => false,
			},
			settingsManager: { flush },
			onReload: reload,
			onClose: () => {},
			tui: { requestRender: () => {} },
		});

		await component.updatePlugins();

		expect(update).toHaveBeenCalledWith(undefined);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("can be mounted in an editor container", () => {
		const container = new Container();
		const component = new CodexPluginManagerComponent({
			pluginManager: {
				listConfiguredPlugins: () => [],
				listMarketplaces: () => [],
				searchMarketplaces: async () => [],
				install: async () => ({
					name: "superpowers",
					source: "https://github.com/example/superpowers",
					enabled: true,
					scope: "user" as const,
				}),
				remove: () => false,
				update: async () => {},
				addMarketplace: () => {},
				removeMarketplace: () => false,
			},
			settingsManager: { flush: async () => {} },
			onReload: async () => {},
			onClose: () => {},
			tui: { requestRender: () => {} },
		});

		container.addChild(component);

		expect(container.children[0]).toBe(component);
	});
});
