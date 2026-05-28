import type { ExtensionAPI } from "./pi-types.ts";

export type BuiltinPluginId = "mcp";

export type BuiltinPluginFactory = (pi: ExtensionAPI) => void | Promise<void>;

export interface BuiltinPluginManifest {
	id: BuiltinPluginId;
	name: string;
	description: string;
	defaultEnabled: boolean;
	factory: BuiltinPluginFactory;
}
