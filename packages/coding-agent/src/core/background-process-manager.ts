import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessTree, untrackDetachedChildPid } from "../utils/shell.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";

export interface BackgroundProcess {
	id: string;
	pid: number;
	command: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	status: "running" | "completed";
	output: OutputAccumulator;
	child: ChildProcess;
}

export type BackgroundProcessCompletedCallback = (proc: BackgroundProcess) => void;

/** Fired whenever the set of background processes changes (added, completed, killed). */
export type BackgroundProcessChangeCallback = () => void;

/**
 * Manages background processes that were timed out and moved off the bash tool's
 * critical path. Each process keeps streaming its output into an OutputAccumulator
 * and fires completion callbacks when it exits.
 */
export class BackgroundProcessManager {
	private readonly processes = new Map<string, BackgroundProcess>();
	private readonly completedCallbacks = new Set<BackgroundProcessCompletedCallback>();
	private readonly changeCallbacks = new Set<BackgroundProcessChangeCallback>();

	private emitChange(): void {
		for (const cb of this.changeCallbacks) cb();
	}

	/**
	 * Adopt a running child process as a background process.
	 * Sets up independent output capture and exit monitoring.
	 *
	 * The caller must have already removed any existing `data` listeners that
	 * belonged to a different output sink, so that this manager becomes the sole
	 * consumer of stdout/stderr.
	 */
	adopt(child: ChildProcess, command: string, cwd: string): BackgroundProcess {
		const id = randomUUID();
		const output = new OutputAccumulator({ tempFilePrefix: "pi-bash-bg" });

		const handleData = (data: Buffer): void => {
			try {
				output.append(data);
			} catch {
				// OutputAccumulator finished — ignore late data
			}
		};

		child.stdout?.on("data", handleData);
		child.stderr?.on("data", handleData);

		const proc: BackgroundProcess = {
			id,
			pid: child.pid!,
			command,
			cwd,
			startedAt: Date.now(),
			status: "running",
			output,
			child,
		};

		this.processes.set(id, proc);
		this.emitChange();

		// Use 'close' instead of 'exit' to ensure all stdio data has been flushed
		// before we finalize the output. The 'exit' event fires when the process
		// terminates but stdio streams may still have buffered data.
		child.once("close", (code) => {
			proc.status = "completed";
			proc.endedAt = Date.now();
			proc.exitCode = code;
			try {
				output.finish();
			} catch {
				// Already finished — race with stdout end
			}
			// Untrack PID so trackedDetachedChildPids doesn't grow unbounded.
			untrackDetachedChildPid(proc.pid);
			for (const cb of this.completedCallbacks) {
				cb(proc);
			}
			this.emitChange();
		});

		return proc;
	}

	/** Kill a running background process by id. No-op if not found or already completed. */
	kill(id: string): void {
		const proc = this.processes.get(id);
		if (!proc || proc.status !== "running") return;
		killProcessTree(proc.pid);
		// The exit handler registered in adopt() will update status and fire callbacks.
	}

	/** Kill all running background processes. Called during shutdown. */
	killAll(): void {
		for (const proc of this.processes.values()) {
			if (proc.status === "running") {
				killProcessTree(proc.pid);
			}
		}
	}

	getAll(): BackgroundProcess[] {
		return [...this.processes.values()];
	}

	getById(id: string): BackgroundProcess | undefined {
		return this.processes.get(id);
	}

	/** Remove a completed process from the registry. Also untracks its PID. */
	remove(id: string): void {
		const proc = this.processes.get(id);
		if (!proc) return;
		untrackDetachedChildPid(proc.pid);
		this.processes.delete(id);
		this.emitChange();
	}

	/** Count of currently running background processes. */
	getRunningCount(): number {
		let count = 0;
		for (const proc of this.processes.values()) {
			if (proc.status === "running") count++;
		}
		return count;
	}

	/** Register a callback fired when any background process exits. Returns an unsubscribe function. */
	onCompleted(cb: BackgroundProcessCompletedCallback): () => void {
		this.completedCallbacks.add(cb);
		return () => {
			this.completedCallbacks.delete(cb);
		};
	}

	/** Register a callback fired when the process set changes (added/completed/killed). Returns an unsubscribe function. */
	onChange(cb: BackgroundProcessChangeCallback): () => void {
		this.changeCallbacks.add(cb);
		return () => {
			this.changeCallbacks.delete(cb);
		};
	}
}
