import type { BuiltinPluginManifest } from "../types.ts";
import tpsPlugin from "./index.ts";

export const tpsPluginManifest: BuiltinPluginManifest = {
	id: "tps",
	name: "TPS",
	description: "Built-in tokens-per-second monitor. Shows output speed and token usage after each agent turn.",
	defaultEnabled: true,
	factory: tpsPlugin,
};
