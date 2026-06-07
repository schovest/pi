import type { BuiltinPluginManifest } from "../types.ts";
import factory from "./index.ts";

export const todoPluginManifest: BuiltinPluginManifest = {
	id: "todo",
	name: "Todo",
	description: "Task tracking and todo list management for the agent",
	defaultEnabled: true,
	factory,
};
