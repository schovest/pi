import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import {
	APP_NAME,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	VERSION,
} from "./config.ts";
import { PluginManager } from "./core/claude-plugin-manager.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "./core/trust-manager.ts";
import { spawnProcess } from "./utils/child-process.ts";
import { getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "extensions"; source?: string };

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	local: boolean;
	force: boolean;
	selfUpdate: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self|pi] [--self] [--extensions] [--extension <source>] [--approve|--no-approve] [--force]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (.pi/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local       Remove from project settings (.pi/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update installed packages.

Options:
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command
  --force                 Reinstall pi even if the current version is latest

Short forms:
  ${APP_NAME} update                Update all extensions
  ${APP_NAME} update <source>       Update one package
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  -a, --approve      Trust project-local files for this command
  -na, --no-approve  Ignore project-local files for this command
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let selfUpdate = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let extensionsFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}

		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfUpdate = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	if (command === "update") {
		if (extensionFlagSource) {
			if (extensionsFlag) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with --extensions";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			if (extensionsFlag) {
				conflictingOptions = conflictingOptions ?? "positional update targets cannot be combined with --extensions";
			}
			updateTarget = { type: "extensions", source };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "all" };
		}
	}

	return {
		command,
		source,
		updateTarget,
		local,
		force,
		selfUpdate,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

function _printSelfUpdateUnavailable(npmCommand?: string[], updatePackageName = PACKAGE_NAME): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageName));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of pi executable: ${entrypoint}`);
	}
}

function _printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => text,
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

function _printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	packageName: string;
	shouldRun: boolean;
	note?: string;
}

async function _getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	if (force) {
		return { packageName: PACKAGE_NAME, shouldRun: true };
	}

	try {
		const latestRelease = await getLatestPiRelease(VERSION);
		const packageName = latestRelease?.packageName ?? PACKAGE_NAME;
		if (!latestRelease || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
			return { packageName, shouldRun: true, ...(latestRelease?.note ? { note: latestRelease.note } : {}) };
		}
	} catch {
		return { packageName: PACKAGE_NAME, shouldRun: true };
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName: PACKAGE_NAME, shouldRun: false };
}

async function _runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

function _prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}

function parseProjectTrustOverride(args: readonly string[]): boolean | undefined {
	let trustOverride: boolean | undefined;
	for (const arg of args) {
		if (arg === "--approve" || arg === "-a") {
			trustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			trustOverride = false;
		}
	}
	return trustOverride;
}

export interface PackageCommandRuntimeOptions {
	extensionFactories?: ExtensionFactory[];
}

interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	extensionFactories?: ExtensionFactory[];
}): Promise<CommandSettingsResult> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const projectTrustWarnings: string[] = [];
	const appMode = getCommandAppMode();
	const extensionsResult =
		options.projectTrustOverride === undefined && hasProjectTrustInputs(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore: new ProjectTrustStore(options.agentDir),
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: parseProjectTrustOverride(args),
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

function printPluginCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} plugins marketplace add <name> <repo-or-url>
  ${APP_NAME} plugins marketplace list
  ${APP_NAME} plugins marketplace remove <name>
  ${APP_NAME} plugins search [query] [--marketplace <name>]
  ${APP_NAME} plugins install <name@marketplace|git-url|https-url> [-l]
  ${APP_NAME} plugins list
  ${APP_NAME} plugins remove <plugin> [-l]
  ${APP_NAME} plugins update [plugin]

Claude-compatible plugins are managed separately from Pi packages. Use ${APP_NAME} install/list for native packages.
`);
}

export async function handlePluginCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "plugins") {
		return false;
	}

	const [, command, ...rest] = args;
	if (!command || command === "-h" || command === "--help") {
		printPluginCommandHelp();
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "plugin command");
	const pluginManager = new PluginManager({ cwd, agentDir, settingsManager });

	try {
		if (command === "marketplace") {
			const [action, name, source] = rest;
			if (action === "add" && name && source) {
				pluginManager.addMarketplace(name, source);
				await settingsManager.flush();
				console.log(chalk.green(`Added plugin marketplace ${name}`));
				return true;
			}
			if (action === "list") {
				const marketplaces = pluginManager.listMarketplaces();
				if (marketplaces.length === 0) {
					console.log(chalk.dim("No plugin marketplaces configured."));
					return true;
				}
				for (const marketplace of marketplaces) {
					console.log(`${marketplace.name}  ${chalk.dim(marketplace.source)}`);
				}
				return true;
			}
			if (action === "remove" && name) {
				const removed = pluginManager.removeMarketplace(name);
				await settingsManager.flush();
				if (!removed) {
					console.error(chalk.red(`No matching plugin marketplace found for ${name}`));
					process.exitCode = 1;
				} else {
					console.log(chalk.green(`Removed plugin marketplace ${name}`));
				}
				return true;
			}
			printPluginCommandHelp();
			process.exitCode = 1;
			return true;
		}

		if (command === "search") {
			let marketplace: string | undefined;
			const positional: string[] = [];
			for (let i = 0; i < rest.length; i++) {
				const arg = rest[i];
				if (arg === "-m" || arg === "--marketplace") {
					const value = rest[i + 1];
					if (!value) {
						printPluginCommandHelp();
						process.exitCode = 1;
						return true;
					}
					marketplace = value;
					i++;
				} else if (arg?.startsWith("-")) {
					printPluginCommandHelp();
					process.exitCode = 1;
					return true;
				} else if (arg) {
					positional.push(arg);
				}
			}
			if (positional.length > 1) {
				printPluginCommandHelp();
				process.exitCode = 1;
				return true;
			}

			if (pluginManager.listMarketplaces().length === 0) {
				console.log(chalk.dim("No plugin marketplaces configured."));
				return true;
			}

			const results = await pluginManager.searchMarketplaces(positional[0], { marketplace });
			if (results.length === 0) {
				console.log(chalk.dim("No matching plugins found."));
				return true;
			}
			for (const result of results) {
				const ref = result.ref ?? "-";
				const installed = result.installed ? " installed" : "";
				console.log(
					`${result.name}@${result.marketplace}  ${chalk.dim(result.source)}  ${chalk.dim(ref)}${chalk.green(installed)}`,
				);
			}
			return true;
		}

		let local = false;
		const positional: string[] = [];
		for (const arg of rest) {
			if (arg === "-l" || arg === "--local") {
				local = true;
			} else {
				positional.push(arg);
			}
		}

		if (command === "install") {
			const source = positional[0];
			if (!source || positional.length > 1) {
				printPluginCommandHelp();
				process.exitCode = 1;
				return true;
			}
			const installed = await pluginManager.install(source, { local });
			await settingsManager.flush();
			console.log(chalk.green(`Installed plugin ${installed.name}`));
			return true;
		}

		if (command === "list") {
			const plugins = pluginManager.listConfiguredPlugins();
			if (plugins.length === 0) {
				console.log(chalk.dim("No Claude-compatible plugins installed."));
				return true;
			}
			for (const plugin of plugins) {
				const scope = plugin.scope === "project" ? "project" : "user";
				const disabled = plugin.enabled ? "" : " disabled";
				console.log(`${plugin.name}  ${chalk.dim(`${scope}${disabled} ${plugin.source}`)}`);
				if (plugin.installedPath) {
					console.log(chalk.dim(`  ${plugin.installedPath}`));
				}
			}
			return true;
		}

		if (command === "remove") {
			const name = positional[0];
			if (!name || positional.length > 1) {
				printPluginCommandHelp();
				process.exitCode = 1;
				return true;
			}
			const removed = pluginManager.remove(name, { local });
			await settingsManager.flush();
			if (!removed) {
				console.error(chalk.red(`No matching plugin found for ${name}`));
				process.exitCode = 1;
			} else {
				console.log(chalk.green(`Removed plugin ${name}`));
			}
			return true;
		}

		if (command === "update") {
			const name = positional[0];
			if (positional.length > 1) {
				printPluginCommandHelp();
				process.exitCode = 1;
				return true;
			}
			await pluginManager.update(name);
			await settingsManager.flush();
			console.log(chalk.green(name ? `Updated plugin ${name}` : "Updated plugins"));
			return true;
		}

		printPluginCommandHelp();
		process.exitCode = 1;
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown plugin command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				if (options.selfUpdate) {
					const plan = await _getSelfUpdatePlan(options.force);
					if (!plan.shouldRun) {
						return true;
					}
					const npmCommand = settingsManager.getNpmCommand();
					const command = getSelfUpdateCommand(PACKAGE_NAME, npmCommand, plan.packageName);
					if (!command) {
						_printSelfUpdateUnavailable(npmCommand, PACKAGE_NAME);
						process.exitCode = 1;
						return true;
					}
					if (plan.note) {
						_printSelfUpdateNote(plan.note);
					}
					_prepareWindowsNpmSelfUpdate();
					await _runSelfUpdate(command);
					console.log(chalk.green(`Updated ${APP_NAME}`));
					return true;
				}
				const target = options.updateTarget ?? { type: "all" };
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
