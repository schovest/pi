import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getProjectTrustPath,
	hasProjectConfigDir,
	hasProjectTrustInputs,
	ProjectTrustStore,
} from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions per cwd", () => {
		const store = new ProjectTrustStore(agentDir);

		expect(store.get(cwd)).toBeNull();
		expect(store.getEntry(cwd)).toBeNull();
		store.set(cwd, true);
		expect(store.get(cwd)).toBe(true);
		expect(store.getEntry(cwd)).toEqual({ path: getProjectTrustPath(cwd), decision: true });
		store.set(cwd, false);
		expect(store.get(cwd)).toBe(false);
		expect(store.getEntry(cwd)).toEqual({ path: getProjectTrustPath(cwd), decision: false });
		store.set(cwd, null);
		expect(store.get(cwd)).toBeNull();
		expect(store.getEntry(cwd)).toBeNull();
	});

	it("inherits the closest saved decision from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		const grandchildDir = join(childDir, "nested");
		mkdirSync(grandchildDir, { recursive: true });

		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		expect(store.getEntry(childDir)).toEqual({ path: getProjectTrustPath(parentDir), decision: true });
		expect(store.get(grandchildDir)).toBe(true);
		expect(store.getEntry(grandchildDir)).toEqual({ path: getProjectTrustPath(parentDir), decision: true });

		store.set(childDir, false);
		expect(store.get(grandchildDir)).toBe(false);
		expect(store.getEntry(grandchildDir)).toEqual({ path: getProjectTrustPath(childDir), decision: false });
	});

	it("can clear a child override to inherit parent trust", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		store.set(parentDir, true);
		store.set(childDir, false);
		expect(store.getEntry(childDir)).toEqual({ path: getProjectTrustPath(childDir), decision: false });

		store.setMany([
			{ path: parentDir, decision: true },
			{ path: childDir, decision: null },
		]);
		expect(store.get(childDir)).toBe(true);
		expect(store.getEntry(childDir)).toEqual({ path: getProjectTrustPath(parentDir), decision: true });
	});

	it("fails loudly without overwriting malformed trust stores", () => {
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, "{not json", "utf-8");
		const store = new ProjectTrustStore(agentDir);

		expect(() => store.get(cwd)).toThrow(/Failed to read trust store/);
		expect(() => store.set(cwd, true)).toThrow(/Failed to read trust store/);
		expect(readFileSync(trustPath, "utf-8")).toBe("{not json");
	});

	it("detects project trust inputs", () => {
		// hasProjectConfigDir and hasProjectTrustInputs may be affected by ancestor
		// directories (e.g. user-level .agents). Verify the detection delta.
		const hadConfigDirBefore = hasProjectConfigDir(cwd);
		const hadTrustInputsBefore = hasProjectTrustInputs(cwd);

		mkdirSync(join(cwd, ".pi"), { recursive: true });
		expect(hasProjectConfigDir(cwd)).toBe(true);
		// Bare .pi alone is NOT a trust input unless it contains config resources
		rmSync(join(cwd, ".pi"), { recursive: true, force: true });
		expect(hasProjectConfigDir(cwd)).toBe(hadConfigDirBefore);

		// AGENTS.md and CLAUDE.md alone do NOT trigger trust
		writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
		expect(hasProjectTrustInputs(cwd)).toBe(hadTrustInputsBefore);
		rmSync(join(cwd, "AGENTS.md"), { force: true });

		writeFileSync(join(cwd, "CLAUDE.md"), "Legacy project instructions");
		expect(hasProjectTrustInputs(cwd)).toBe(hadTrustInputsBefore);
		rmSync(join(cwd, "CLAUDE.md"), { force: true });

		// .agents/skills SHOULD trigger trust (unless it matches user home)
		mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
		expect(hasProjectTrustInputs(cwd)).toBe(true);
	});

	it("should ignore .agents/skills as trust input when enableAgentsSkills is false", () => {
		mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
		expect(hasProjectTrustInputs(cwd, { enableAgentsSkills: false })).toBe(false);
		// 默认参数保持现状：仍视为信任输入
		expect(hasProjectTrustInputs(cwd)).toBe(true);
	});
});
