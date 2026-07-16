import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// pi-tui is still a workspace package — alias it to source for fast iteration.
// pi-ai and pi-agent-core are now upstream npm packages — let vite resolve them naturally.
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@earendil-works\/pi-ai/, /@earendil-works\/pi-agent-core/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@schovest\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
	ssr: {
		noExternal: [],
	},
});
