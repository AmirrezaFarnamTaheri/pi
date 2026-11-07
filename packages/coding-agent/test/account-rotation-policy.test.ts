import { describe, expect, it } from "vitest";
import { RotationPool, classifyCredentialFailure } from "../src/extensions/account-rotation-policy.ts";

const accounts = [
	{ provider: "anthropic", model: "sonnet" },
	{ provider: "anthropic-key-2", model: "sonnet" },
	{ provider: "anthropic-account-3", model: "sonnet" },
];

describe("AccountRotationPool", () => {
	it("rotates new user turns and keeps tool continuations on the same account", () => {
		const pool = new RotationPool(accounts);
		expect(pool.choose({ reason: "user", now: 0 }).index).toBe(0);
		expect(pool.choose({ reason: "continuation", previous: accounts[0], now: 0 }).index).toBe(0);
		expect([0, 1, 2].map(() => pool.choose({ reason: "user", now: 0 }).index)).toEqual([1, 2, 0]);
	});

	it("fails over on a pre-output 429 and skips the failed key during cooldown", () => {
		const pool = new RotationPool(accounts, 1_000);
		pool.choose({ reason: "user", now: 0 });
		expect(pool.choose({ reason: "retry", failed: { target: accounts[0], errorMessage: "HTTP 429", hasOutput: false }, now: 1 }).index).toBe(1);
		expect(pool.choose({ reason: "user", now: 500 }).index).toBe(2);
		expect(pool.choose({ reason: "user", now: 1_100 }).index).toBe(0);
	});

	it("quarantines invalid credentials for longer than ordinary overload", () => {
		const pool = new RotationPool(accounts, 1_000);
		expect(pool.choose({ reason: "retry", failed: { target: accounts[0], errorMessage: "401 invalid api key", hasOutput: false }, now: 0 }).index).toBe(1);
		expect(pool.status(1_500)[0]?.readyInMs).toBeGreaterThan(0);
	});

	it("does not move accounts after partial output or content-policy failures", () => {
		const pool = new RotationPool(accounts);
		for (const [errorMessage, hasOutput] of [["429 rate limit", true], ["403 content policy", false], ["context length exceeded", false]] as const) {
			expect(pool.choose({ reason: "retry", failed: { target: accounts[1], errorMessage, hasOutput }, now: 0 }).index).toBe(1);
		}
	});

	it("stops when all credentials are cooling down and allows manual reset", () => {
		const pool = new RotationPool(accounts, 1_000);
		for (const account of accounts.slice(0, 2)) pool.choose({ reason: "retry", failed: { target: account, errorMessage: "429", hasOutput: false }, now: 0 });
		expect(() => pool.choose({ reason: "retry", failed: { target: accounts[2], errorMessage: "429", hasOutput: false }, now: 0 })).toThrow(/all.*cooling down/i);
		pool.reset();
		expect(pool.choose({ reason: "user", now: 0 }).index).toBe(0);
	});

	it("does not consume the round-robin cursor for direct summary requests", () => {
		const pool = new RotationPool(accounts);
		expect(pool.choose({ reason: "direct", now: 0 }).index).toBe(0);
		expect(pool.choose({ reason: "user", now: 0 }).index).toBe(0);
	});

	it("rejects repeated targets", () => {
		expect(() => new RotationPool([accounts[0], accounts[0]])).toThrow(/duplicate/i);
	});

	it("classifies provider failures conservatively", () => {
		expect(classifyCredentialFailure("429 Too Many Requests")).toBe("rate-limit");
		expect(classifyCredentialFailure("401 Unauthorized")).toBe("auth");
		expect(classifyCredentialFailure("503 overloaded")).toBe("overload");
		expect(classifyCredentialFailure("403 content policy")).toBeUndefined();
		expect(classifyCredentialFailure("context window exceeded")).toBeUndefined();
	});
});

describe("rotation state restored after another provider was selected", () => {
	it("uses the saved pool slot when the most recent physical model is outside the pool", () => {
		const pool = new RotationPool(accounts);
		const chosen = pool.choose({
			reason: "continuation",
			previous: { provider: "unrelated", model: "outside" },
			active: accounts[2],
			now: 0,
		});
		expect(chosen.index).toBe(2);
	});
});
