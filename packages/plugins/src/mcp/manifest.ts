import type { BuiltinPluginManifest } from "../types.ts";
import mcpAdapter from "./adapter/index.ts";

export const mcpPluginManifest: BuiltinPluginManifest = {
	id: "mcp",
	name: "MCP",
	description: "Built-in MCP adapter, proxy tool, direct tools, OAuth, and MCP Apps UI support.",
	defaultEnabled: true,
	factory: mcpAdapter,
};
