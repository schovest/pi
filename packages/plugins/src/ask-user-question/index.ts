/**
 * rpiv-ask-user-question — Pi extension. Registers the `ask_user_question`
 * tool: a structured option selector with a free-text "Other" fallback.
 *
 * Adapted for the builtin plugin architecture. i18n dynamic imports have been
 * removed — the bridge always returns English fallback text.
 */

import type { ExtensionAPI } from "../pi-types.ts";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

export {
	ASK_USER_PROMPT_EVENT,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./events.js";

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
}
