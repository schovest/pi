import type { BuiltinPluginManifest } from "../types.ts";
import askUserQuestionPlugin from "./index.ts";

export const askUserQuestionPluginManifest: BuiltinPluginManifest = {
	id: "ask-user-question",
	name: "Ask User Question",
	description: "Built-in ask_user_question tool for structured option selection with free-text fallback.",
	defaultEnabled: true,
	factory: askUserQuestionPlugin,
};
