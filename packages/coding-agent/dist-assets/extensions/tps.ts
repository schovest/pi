import type { AssistantMessage } from "@schovest/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@schovest/pi-coding-agent";

// Runtime ExtensionAPI has more methods than the type declarations.
type RichExtensionAPI = ExtensionAPI & {
	on(event: "agent_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "agent_end", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
};

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

export default function tpsPlugin(pi: ExtensionAPI): void {
	const api = pi as RichExtensionAPI;
	let agentStartMs: number | null = null;

	api.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	api.on("agent_end", (event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		const e = event as { messages: unknown[] };
		for (const message of e.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const msg = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
		ctx.ui.notify(msg, "info");
	});
}
