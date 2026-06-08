import { askUserQuestionPluginManifest } from "./ask-user-question/manifest.ts";
import { btwPluginManifest } from "./btw/manifest.ts";
import { mcpPluginManifest } from "./mcp/manifest.ts";
import { planPluginManifest } from "./plan/manifest.ts";
import { todoPluginManifest } from "./todo/manifest.ts";
import { tpsPluginManifest } from "./tps/manifest.ts";
import type { BuiltinPluginManifest } from "./types.ts";

export const BUILTIN_PLUGINS: readonly BuiltinPluginManifest[] = [
	mcpPluginManifest,
	planPluginManifest,
	todoPluginManifest,
	askUserQuestionPluginManifest,
	tpsPluginManifest,
	btwPluginManifest,
];
