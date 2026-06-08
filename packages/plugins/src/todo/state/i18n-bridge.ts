/**
 * i18n bridge for rpiv-todo — pure English fallback.
 *
 * Previously backed by `@juicesharp/rpiv-i18n`'s SDK; the SDK dependency has
 * been removed. `t(key, fallback)` unconditionally returns the English
 * fallback string, and `formatStatusLabel` resolves status labels directly.
 */

import type { TaskStatus } from "../tool/types.ts";

const STATUS_LABELS: Record<TaskStatus, string> = {
	pending: "Pending",
	in_progress: "In Progress",
	completed: "Completed",
	deleted: "Deleted",
};

export function formatStatusLabel(status: TaskStatus): string {
	return STATUS_LABELS[status] ?? status;
}

export function t(_key: string, fallback: string): string {
	return fallback;
}

export const I18N_NAMESPACE = "rpiv-todo";
