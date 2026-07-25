import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare native streaming", () => {
	it("resolves Cloudflare AI Gateway auth through ModelRuntime", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();

		const auth = await modelRuntime.getAuth(model!);
		expect(auth).toBeDefined();
		// Cloudflare AI Gateway uses cf-aig-authorization header, not standard apiKey
		expect(auth!.auth.headers!["cf-aig-authorization"]).toBe("Bearer test-token");
		// Standard auth headers are suppressed
		expect(auth!.auth.headers!.Authorization).toBeNull();
		expect(auth!.auth.headers!["x-api-key"]).toBeNull();
		// Env contains the account and gateway IDs for base URL resolution
		expect(auth!.env?.CLOUDFLARE_ACCOUNT_ID).toBe("test-account");
		expect(auth!.env?.CLOUDFLARE_GATEWAY_ID).toBe("test-gateway");
		expect(auth!.source).toBe("stored credential");
	});

	it("resolves Cloudflare AI Gateway auth after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();

		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);

		// Cloudflare uses custom headers instead of apiKey
		expect(auth.apiKey).toBeUndefined();
		expect(auth.headers?.["cf-aig-authorization"]).toBe("Bearer test-token");
		expect(auth.env?.CLOUDFLARE_ACCOUNT_ID).toBe("test-account");
		expect(auth.env?.CLOUDFLARE_GATEWAY_ID).toBe("test-gateway");
	});
});
