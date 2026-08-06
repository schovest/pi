import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Title text embedded in the top border line */
	borderTitle?: string;

	/** Right-aligned title text embedded in the top border line */
	borderTitleRight?: string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/**
	 * Set the prompt prefix shown before the first input line (e.g. "> " or "$ ").
	 * Continuation lines render blank padding of the same width so all lines stay
	 * aligned. Pass an empty string to disable.
	 */
	setPromptPrefix?(prefix: string, color?: (str: string) => string): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
