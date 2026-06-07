/**
 * i18n bridge for rpiv-ask-user-question — English-only fallback.
 * All i18n dynamic imports have been removed for the builtin plugin architecture.
 */

import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";

export function t(_key: string, fallback: string): string {
	return fallback;
}

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
