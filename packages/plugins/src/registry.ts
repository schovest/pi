import { mcpPluginManifest } from "./mcp/manifest.ts";
import { planPluginManifest } from "./plan/manifest.ts";
import type { BuiltinPluginManifest } from "./types.ts";

export const BUILTIN_PLUGINS: readonly BuiltinPluginManifest[] = [mcpPluginManifest, planPluginManifest];
