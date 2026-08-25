import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFloodGuard,
	createSnapshotGate,
	DEFAULT_SNAPSHOT_INTERVAL_MS,
} from "../../src/core/extensions/append-policy.ts";

describe("snapshot gate", () => {
	it("persists the first snapshot and dedups unchanged content", () => {
		const gate = createSnapshotGate();
		const options = { kind: "snapshot" as const };
		assert.equal(gate.shouldPersist("goal", { a: 1 }, options, 1_000), true);
		assert.equal(gate.shouldPersist("goal", { a: 1 }, options, 2_000), false);
		assert.equal(gate.shouldPersist("goal", { a: 2 }, options, 3_000), true);
	});

	it("ignores declared volatile keys when comparing", () => {
		const gate = createSnapshotGate();
		const options = { kind: "snapshot" as const, volatileKeys: ["updatedAt", "revision"] };
		assert.equal(gate.shouldPersist("goal", { a: 1, updatedAt: "t1", revision: 1 }, options, 1_000), true);
		// Only volatile churn: suppressed inside the interval.
		assert.equal(gate.shouldPersist("goal", { a: 1, updatedAt: "t2", revision: 2 }, options, 2_000), false);
		// Significant change persists immediately regardless of interval.
		assert.equal(gate.shouldPersist("goal", { a: 2, updatedAt: "t3", revision: 3 }, options, 2_500), true);
	});

	it("refreshes unchanged snapshots after the interval (bounded crash staleness)", () => {
		const gate = createSnapshotGate();
		const options = { kind: "snapshot" as const, volatileKeys: ["updatedAt"] };
		assert.equal(gate.shouldPersist("goal", { a: 1, updatedAt: "t1" }, options, 0), true);
		assert.equal(gate.shouldPersist("goal", { a: 1, updatedAt: "t2" }, options, DEFAULT_SNAPSHOT_INTERVAL_MS - 1), false);
		assert.equal(gate.shouldPersist("goal", { a: 1, updatedAt: "t3" }, options, DEFAULT_SNAPSHOT_INTERVAL_MS + 1), true);
	});

	it("tracks custom types independently and honors custom intervals", () => {
		const gate = createSnapshotGate();
		assert.equal(gate.shouldPersist("a", { v: 1 }, { minIntervalMs: 1_000 }, 0), true);
		assert.equal(gate.shouldPersist("b", { v: 1 }, { minIntervalMs: 1_000 }, 0), true);
		assert.equal(gate.shouldPersist("a", { v: 1 }, { minIntervalMs: 1_000 }, 500), false);
		assert.equal(gate.shouldPersist("a", { v: 1 }, { minIntervalMs: 1_000 }, 1_500), true);
	});
});

describe("flood guard", () => {
	it("warns once per window when a customType floods by count", () => {
		const guard = createFloodGuard();
		const warnings: string[] = [];
		for (let i = 0; i < 100; i += 1) guard.record("spammy", { i }, (m) => warnings.push(m), 1_000 + i);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /spammy/);
		assert.match(warnings[0]!, /kind: "snapshot"/);
	});

	it("stays silent for reasonable event rates and resets per window", () => {
		const guard = createFloodGuard();
		const warnings: string[] = [];
		for (let i = 0; i < 50; i += 1) guard.record("calm", { i }, (m) => warnings.push(m), 1_000 + i * 10);
		// New window after 60s: counter restarts.
		for (let i = 0; i < 50; i += 1) guard.record("calm", { i }, (m) => warnings.push(m), 70_000 + i * 10);
		assert.equal(warnings.length, 0);
	});

	it("warns on byte volume even at low counts", () => {
		const guard = createFloodGuard();
		const warnings: string[] = [];
		const big = "x".repeat(200 * 1024);
		for (let i = 0; i < 4; i += 1) guard.record("bulky", { big }, (m) => warnings.push(m), 1_000 + i);
		assert.equal(warnings.length, 1);
	});
});
