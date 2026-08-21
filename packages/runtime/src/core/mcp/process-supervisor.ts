/**
 * Ephemeral connection leases below `<agentDir>/runtime/mcp/` (docs/31
 * sections 5 and 7). A lease records exact engine/server process identity
 * without command args or environment, so a crashed engine's servers can be
 * reaped later without letting a stale PID file kill an unrelated reused PID.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface McpLease {
	readonly version: 1;
	readonly leaseId: string;
	readonly serverId: string;
	readonly enginePid: number;
	readonly serverPid: number;
	readonly processGroup: number | null;
	readonly createdAt: string;
}

export class McpProcessSupervisor {
	private readonly root: string;

	constructor(agentDir: string) {
		this.root = resolve(agentDir, "runtime", "mcp");
	}

	async writeLease(serverId: string, serverPid: number): Promise<string> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const lease: McpLease = {
			version: 1,
			leaseId: randomUUID(),
			serverId,
			enginePid: process.pid,
			serverPid,
			processGroup: process.platform === "win32" ? null : serverPid,
			createdAt: new Date().toISOString(),
		};
		await writeFile(join(this.root, `${lease.leaseId}.json`), `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		return lease.leaseId;
	}

	async removeLease(leaseId: string): Promise<void> {
		if (!/^[0-9a-f-]{36}$/u.test(leaseId)) return;
		await rm(join(this.root, `${leaseId}.json`), { force: true });
	}

	/**
	 * Prune validated stale leases: the engine must be dead, and a still-live
	 * recorded server process receives group SIGTERM then SIGKILL. Malformed
	 * lease files are removed without signalling anything.
	 */
	async pruneStale(): Promise<number> {
		let pruned = 0;
		let entries: string[];
		try {
			entries = await readdir(this.root);
		} catch {
			return 0;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const path = join(this.root, entry);
			let lease: McpLease | undefined;
			try {
				const parsed = JSON.parse(await readFile(path, "utf8")) as McpLease;
				if (parsed.version === 1 && Number.isInteger(parsed.enginePid) && Number.isInteger(parsed.serverPid)) lease = parsed;
			} catch {
				// Malformed lease: fall through to removal without signalling.
			}
			if (lease) {
				if (lease.enginePid === process.pid || processAlive(lease.enginePid)) continue;
				if (processAlive(lease.serverPid)) {
					signalGroup(lease, "SIGTERM");
					await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
					if (processAlive(lease.serverPid)) signalGroup(lease, "SIGKILL");
				}
			}
			await rm(path, { force: true });
			pruned += 1;
		}
		return pruned;
	}
}

function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(lease: McpLease, signal: NodeJS.Signals): void {
	try {
		if (lease.processGroup && process.platform !== "win32") process.kill(-lease.processGroup, signal);
		else process.kill(lease.serverPid, signal);
	} catch {
		// Already gone.
	}
}
