import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { EditorComponent } from "@schovest/pi-tui";
import { type Component, truncateToWidth, visibleWidth } from "@schovest/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { formatTokenCount } from "../../../utils/format-token-count.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * computeFooterUsage 的轻量输入条目类型：兼容 SessionEntry 与 LazyEntry 运行时变体。
 * LazyEntry 占位（compaction 前大行）无 .message，靠 optional chaining 自然跳过。
 */
export interface FooterUsageSourceEntry {
	type: string;
	message?: { role?: string; usage?: Usage };
	usage?: Usage;
	/** Compaction entry：截至 compaction 的累计 usage（含其前全部条目），旧会话无此字段。 */
	cumulativeUsage?: Usage;
}

/** computeFooterUsage 的结果。costTotal 为 usage.cost.total 的累计。 */
export interface FooterUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number;
	/** 最近一条带 usage 的 assistant 消息的 cache hit rate（%），无则 undefined。 */
	latestCacheHitRate: number | undefined;
}

/**
 * 计算 footer 展示的累计 token/花费用量。
 * 以最后一个携带 cumulativeUsage 的 compaction 作基线（其值已含 compaction 前全部
 * usage，包括被 lazy 占位跳过的部分），再累加其后条目的 usage；无此类 compaction
 * （旧会话文件 / 无 compaction）时退化为线性累加全部条目。
 */
export function computeFooterUsage(entries: readonly FooterUsageSourceEntry[]): FooterUsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let costTotal = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of entries) {
		// 带 cumulativeUsage 的 compaction：以它为基线（含其前全部 usage），继续累加其后条目。
		if (entry.type === "compaction" && entry.cumulativeUsage) {
			const cum = entry.cumulativeUsage;
			input = cum.input;
			output = cum.output;
			cacheRead = cum.cacheRead;
			cacheWrite = cum.cacheWrite;
			costTotal = cum.cost.total;
			continue;
		}

		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const u = entry.message.usage;
			if (u) {
				usage = u;
				// Cache hit rate only from assistant messages
				const latestPromptTokens = u.input + u.cacheRead + u.cacheWrite;
				latestCacheHitRate = latestPromptTokens > 0 ? (u.cacheRead / latestPromptTokens) * 100 : undefined;
			}
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			usage = entry.usage;
		}

		if (usage) {
			input += usage.input;
			output += usage.output;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			costTotal += usage.cost.total;
		}
	}

	return { input, output, cacheRead, cacheWrite, costTotal, latestCacheHitRate };
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export type BorderTitleStyle = "plain" | "emoji";

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private editor?: EditorComponent;
	private borderTitleStyle: BorderTitleStyle = "plain";
	/** When false, the built-in footer is not the active displayed footer (a custom
	 *  extension footer replaced it), so we must not push titles onto the editor border. */
	private isActive = true;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, editor?: EditorComponent) {
		this.session = session;
		this.footerData = footerData;
		this.editor = editor;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	/**
	 * Mark whether this built-in footer is the currently displayed footer.
	 * When a custom extension footer is active, set this to false so that
	 * {@link syncEditorBorderTitles} does not overwrite the editor border.
	 */
	setActive(active: boolean): void {
		this.isActive = active;
	}

	setEditor(editor: EditorComponent | undefined): void {
		this.editor = editor;
	}

	setBorderTitleStyle(style: BorderTitleStyle): void {
		this.borderTitleStyle = style;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Push the current agent/model/path titles onto the editor border.
	 *
	 * This must run eagerly (not only during render) because the editor renders
	 * BEFORE this footer in the TUI frame loop: if we only set the titles inside
	 * render(), the editor shows the previous frame's values and lags one render
	 * behind on discrete state changes (agent/model/thinking switch) that trigger
	 * a single re-render.
	 */
	private syncEditorBorderTitles(): void {
		if (!this.isActive || !this.editor) return;

		// Left side: path + branch + agent (model/effort on right)
		this.editor.borderTitle = this.getPathDisplay();

		// Right side: model · effort (thinking level)
		this.editor.borderTitleRight = this.getModelEffortDisplay() || undefined;
	}

	/** Refresh the editor border titles immediately so agent/model/thinking switches appear without a one-frame lag. */
	invalidate(): void {
		// Eagerly push updated agent/model/path titles onto the editor border so
		// discrete state changes (agent/model/thinking switch) refresh synchronously
		// instead of lagging one render frame behind this component's own render.
		this.syncEditorBorderTitles();
	}

	/**
	 * Right side of the editor border title: provider/model + thinking level + session.
	 * Powerlevel10k-style segments: `provider/model` with the provider part dimmed
	 * (provider prefix only when multiple providers are configured); thinking level
	 * in parens colored with the same theme color as the editor border line;
	 * session name as the trailing breadcrumb segment separated by “⟩” in accent.
	 * Shows "provider/model (thinkingLevel) ⟩ session" when thinking is active and a
	 * session name exists; thinking and session segments are omitted when absent.
	 * Intentionally omits "thinking off" to keep the border clean; users can
	 * check thinking status via the /thinking selector or Alt+T cycling.
	 */
	getModelEffortDisplay(): string {
		const state = this.session.state;
		const modelName = state.model?.id || "no-model";

		// Provider prefix when multiple providers configured: dim "provider/"
		const hasProvider = this.footerData.getAvailableProviderCount() > 1 && state.model;
		const modelPart = hasProvider
			? `${theme.fg("dim", `${state.model!.provider}/`)}${theme.fg("accent", modelName)}`
			: theme.fg("accent", modelName);

		let display = modelPart;

		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			if (thinkingLevel !== "off") {
				// Same color as the editor border line for the current thinking level
				const levelColor = theme.getThinkingBorderColor(thinkingLevel);
				display += `${theme.fg("dim", " (")}${levelColor(thinkingLevel)}${theme.fg("dim", ")")}`;
			}
		}

		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			display += `${theme.fg("dim", " ⟩ ")}${theme.fg("accent", sessionName)}`;
		}

		return display;
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Compute the path + branch breadcrumb string for the editor border title.
	 * Powerlevel10k-inspired breadcrumb layout: Π ⟩ agent ⟩ path On branch,
	 * with “⟩” separators between segments. The session name lives on the right
	 * side (model area); see {@link getModelEffortDisplay}. Style depends on
	 * borderTitleStyle: "plain" uses color + breadcrumb separators, "emoji"
	 * uses emoji icons + color.
	 */
	getPathDisplay(): string {
		const pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		const agentRole = this.session.currentPrimaryAgent;

		// Last segment: path, then the branch (“On …”) glued on with a space
		let pathBlock: string;
		let agentPart: string;
		if (this.borderTitleStyle === "emoji") {
			agentPart = agentRole ? theme.fg("text", `🚀${agentRole}`) : "";
			pathBlock = theme.fg("dim", `📁${pwd}`);
			if (branch) {
				pathBlock += ` ${theme.fg("success", `On ${branch}`)}`;
			}
		} else {
			agentPart = agentRole ? theme.fg("text", agentRole) : "";
			pathBlock = theme.fg("dim", pwd);
			if (branch) {
				pathBlock += ` ${theme.fg("success", `On ${branch}`)}`;
			}
		}

		const crumbs = [theme.fg("accent", "Π")];
		if (agentPart) {
			crumbs.push(agentPart);
		}
		crumbs.push(pathBlock);
		return crumbs.join(theme.fg("dim", " ⟩ "));
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Update editor border titles (eager push; editor renders before this footer)
		this.syncEditorBorderTitles();

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const totals = computeFooterUsage(this.session.sessionManager.getEntries());
		const totalInput = totals.input;
		const totalOutput = totals.output;
		const totalCacheRead = totals.cacheRead;
		const totalCacheWrite = totals.cacheWrite;
		const totalCost = totals.costTotal;
		const latestCacheHitRate = totals.latestCacheHitRate;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const runningSubagents = this.session.getRunningSubagentCount();

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatTokenCount(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokenCount(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokenCount(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokenCount(totalCacheWrite)}`);
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRuntime.isUsingOAuth(state.model.provider) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}
		if (runningSubagents > 0) {
			statsParts.push(theme.fg("warning", `subagents:${runningSubagents}`));
		}

		// Show background process count with keybinding hint
		const bgCount = this.session.backgroundProcessManager.getRunningCount();
		if (bgCount > 0) {
			const bgKey = keyText("app.backgroundProcesses");
			statsParts.push(theme.fg("accent", `bg:${bgCount}`) + theme.fg("dim", `(${bgKey})`));
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokenCount(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokenCount(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsContent = statsParts.join(" · ");

		let contentWidth = visibleWidth(statsContent);

		// If statsContent is too wide, truncate it
		if (contentWidth > width) {
			statsContent = truncateToWidth(statsContent, width, "...");
			contentWidth = visibleWidth(statsContent);
		}

		// Pad to full width
		const padding = " ".repeat(Math.max(0, width - contentWidth));

		// Apply dim. statsContent may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper.
		const dimContent = theme.fg("dim", statsContent);
		const dimPadding = theme.fg("dim", padding);

		const lines = [dimContent + dimPadding];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
