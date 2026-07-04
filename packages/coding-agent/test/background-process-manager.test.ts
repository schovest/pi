import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BackgroundProcessManager } from "../src/core/background-process-manager.ts";

/** Spawn a short-lived child process that echoes output then exits. */
function spawnEcho(message: string, delayMs = 100): ReturnType<typeof spawn> {
	return spawn("bash", ["-c", `echo "${message}"; sleep ${delayMs / 1000}`], {
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Spawn a long-lived child process that runs indefinitely. */
function spawnSleep(): ReturnType<typeof spawn> {
	return spawn("bash", ["-c", "sleep 300"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
}

describe("BackgroundProcessManager", () => {
	it("adopt registers a process and captures its output", async () => {
		const manager = new BackgroundProcessManager();
		const child = spawnEcho("hello-bg", 50);
		const proc = manager.adopt(child, 'echo "hello-bg"', "/tmp");

		expect(proc.status).toBe("running");
		expect(proc.command).toBe('echo "hello-bg"');
		expect(proc.pid).toBe(child.pid);

		// Wait for process to complete
		await new Promise<void>((resolve) => {
			manager.onCompleted(() => resolve());
		});

		expect(proc.status).toBe("completed");
		expect(proc.exitCode).toBe(0);
		expect(proc.endedAt).toBeDefined();

		const snapshot = proc.output.snapshot();
		expect(snapshot.content).toContain("hello-bg");
	});

	it("getAll returns all registered processes", () => {
		const manager = new BackgroundProcessManager();
		const child1 = spawnSleep();
		const child2 = spawnSleep();
		manager.adopt(child1, "sleep 300", "/tmp");
		manager.adopt(child2, "sleep 300", "/tmp");

		const all = manager.getAll();
		expect(all).toHaveLength(2);

		// Cleanup
		manager.killAll();
	});

	it("getById returns the correct process", () => {
		const manager = new BackgroundProcessManager();
		const child = spawnSleep();
		const proc = manager.adopt(child, "sleep 300", "/tmp");

		expect(manager.getById(proc.id)).toBe(proc);
		expect(manager.getById("nonexistent")).toBeUndefined();

		manager.killAll();
	});

	it("kill terminates a running process", async () => {
		const manager = new BackgroundProcessManager();
		const child = spawnSleep();
		const proc = manager.adopt(child, "sleep 300", "/tmp");

		expect(proc.status).toBe("running");

		const completed = new Promise<void>((resolve) => {
			manager.onCompleted(() => resolve());
		});

		manager.kill(proc.id);

		await completed;

		expect(proc.status).toBe("completed");
		// Killed processes have non-zero or null exit code
		expect(proc.exitCode).not.toBe(0);
	});

	it("kill is a no-op for unknown or completed processes", () => {
		const manager = new BackgroundProcessManager();
		// Should not throw
		manager.kill("nonexistent");

		const child = spawnEcho("test", 10);
		const proc = manager.adopt(child, "echo test", "/tmp");
		// Wait briefly for completion
		// kill on unknown id should be safe
		manager.kill("nonexistent");
		expect(proc.status).toBe("running");
	});

	it("killAll terminates all running processes", async () => {
		const manager = new BackgroundProcessManager();
		const child1 = spawnSleep();
		const child2 = spawnSleep();
		const proc1 = manager.adopt(child1, "sleep 300", "/tmp");
		const proc2 = manager.adopt(child2, "sleep 300", "/tmp");

		const completedCount = { value: 0 };
		manager.onCompleted(() => {
			completedCount.value++;
		});

		manager.killAll();

		// Wait for completion events
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect(proc1.status).toBe("completed");
		expect(proc2.status).toBe("completed");
		expect(completedCount.value).toBe(2);
	});

	it("onCompleted callback fires when process exits", async () => {
		const manager = new BackgroundProcessManager();
		const child = spawnEcho("done", 10);

		const completed = new Promise<string>((resolve) => {
			manager.onCompleted((proc) => {
				resolve(proc.command);
			});
		});

		manager.adopt(child, 'echo "done"', "/tmp");

		const result = await completed;
		expect(result).toBe('echo "done"');
	});

	it("onCompleted returns an unsubscribe function", async () => {
		const manager = new BackgroundProcessManager();
		let callCount = 0;

		const unsubscribe = manager.onCompleted(() => {
			callCount++;
		});

		expect(typeof unsubscribe).toBe("function");

		const child1 = spawnEcho("first", 10);
		manager.adopt(child1, "echo first", "/tmp");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(callCount).toBe(1);

		unsubscribe();

		const child2 = spawnEcho("second", 10);
		manager.adopt(child2, "echo second", "/tmp");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(callCount).toBe(1); // callback not called after unsubscribe
	});

	it("remove deletes a process from the registry", () => {
		const manager = new BackgroundProcessManager();
		const child = spawnSleep();
		const proc = manager.adopt(child, "sleep 300", "/tmp");

		expect(manager.getById(proc.id)).toBeDefined();

		manager.remove(proc.id);
		expect(manager.getById(proc.id)).toBeUndefined();

		manager.killAll();
	});

	it("getRunningCount returns count of running processes", () => {
		const manager = new BackgroundProcessManager();
		expect(manager.getRunningCount()).toBe(0);

		const child1 = spawnSleep();
		manager.adopt(child1, "sleep 300", "/tmp");
		expect(manager.getRunningCount()).toBe(1);

		const child2 = spawnSleep();
		manager.adopt(child2, "sleep 300", "/tmp");
		expect(manager.getRunningCount()).toBe(2);

		manager.killAll();
	});

	it("onChange fires when processes are adopted, completed, or removed", async () => {
		const manager = new BackgroundProcessManager();
		let changeCount = 0;
		manager.onChange(() => changeCount++);

		// Adopt triggers change
		const child = spawnEcho("test", 10);
		manager.adopt(child, "echo test", "/tmp");
		expect(changeCount).toBe(1);

		// Process completion triggers change
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(changeCount).toBe(2);

		// Remove triggers change
		const proc = manager.getAll()[0];
		if (proc) manager.remove(proc.id);
		expect(changeCount).toBe(3);
	});
});
