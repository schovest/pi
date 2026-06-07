import type { GuidanceFields } from "../config/index.ts";
import { configPath, loadJsonConfig, validateGuidanceFields } from "../config/index.ts";

const CONFIG_PATH = configPath("rpiv-todo");

interface TodoConfig {
	guidance?: GuidanceFields;
}

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(CONFIG_PATH);
}

export { validateGuidanceFields };
