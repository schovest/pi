import type { BuiltinPluginManifest } from "../types.ts";
import planPlugin from "./index.ts";

export const planPluginManifest: BuiltinPluginManifest = {
	id: "plan",
	name: "Plan Mode",
	description: "Built-in plan mode with DAG scheduling, subagent parallel execution, and plan documentation.",
	defaultEnabled: true,
	factory: planPlugin,
};
