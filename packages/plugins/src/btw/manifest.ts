import type { BuiltinPluginManifest } from "../types.ts";
import factory from "./index.ts";

export const btwPluginManifest: BuiltinPluginManifest = {
	id: "btw",
	name: "BTW",
	description: "Ask a side question without polluting the main conversation",
	defaultEnabled: true,
	factory,
};
