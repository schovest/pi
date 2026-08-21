import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-agent-core";
import { formatTokenCount } from "../../utils/format-token-count.ts";

export interface WorkingTokenStats {
	/** 已结束输出波次累计的本提问输出估算值。 */
	runOutputTokens: number;
	/** 当前正在生成的 partial assistant 消息（空闲/波次间隙为 undefined）。 */
	partialMessage?: AgentMessage | null;
}

/** 将一整波 assistant 消息的估算输出累加到 run 累计值。 */
export function accumulateBurst(runOutputTokens: number, message: AgentMessage): number {
	return runOutputTokens + estimateTokens(message);
}

/** 将毫秒格式化为 mm:ss（<1h）或 h:mm:ss（≥1h）。 */
export function formatElapsedTime(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const ss = String(s).padStart(2, "0");
	if (h > 0) {
		return `${h}:${String(m).padStart(2, "0")}:${ss}`;
	}
	return `${m}:${ss}`;
}

/**
 * Working 行尾随 suffix：` · ↓3.4k · 0:42`；无输出时仅时间 ` · 0:42`。
 * 返回串含前导 " · "，由调用方着色。
 */
export function formatWorkingTokenSuffix(stats: WorkingTokenStats, elapsedMs: number): string {
	const partial = stats.partialMessage;
	const total = stats.runOutputTokens + (partial ? estimateTokens(partial) : 0);
	const outPart = total > 0 ? `↓${formatTokenCount(total)}` : "";
	const timePart = formatElapsedTime(elapsedMs);
	return outPart ? ` · ${outPart} · ${timePart}` : ` · ${timePart}`;
}
