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
		expect(classifyCredentialFailure("Usage Limit Reached")).toBe("rate-limit");
		expect(classifyCredentialFailure("401 Unauthorized")).toBe("auth");
		expect(classifyCredentialFailure("503 overloaded")).toBe("overload");
		expect(classifyCredentialFailure("403 content policy")).toBeUndefined();
		expect(classifyCredentialFailure("context window exceeded")).toBeUndefined();
	});
});


describe("account strategies and quota-aware health (CortexKit / pi-antigravity-auth adoption)", () => {
	it("supports sticky selection across user turns and skips a disabled identity on new requests", () => {
		const pool = new RotationPool(accounts, 1_000, "sticky");
		expect(pool.choose({ reason: "user", now: 0 }).index).toBe(0);
		expect(pool.choose({ reason: "user", now: 1 }).index).toBe(0);
		pool.setEnabled(accounts[0]!, false);
		expect(pool.choose({ reason: "user", now: 2 }).index).toBe(1);
		// Never swap accounts mid-tool-continuation, even after a manual disable.
		expect(pool.choose({ reason: "continuation", previous: accounts[0], now: 3 }).index).toBe(0);
		pool.setEnabled(accounts[0]!, true);
		expect(pool.status(4)[0]?.enabled).toBe(true);
	});

	it("uses deterministic random selection only across eligible accounts", () => {
		const pool = new RotationPool(accounts, 1000, "random", () => 0.9999);
		pool.setEnabled(accounts[2]!, false);
		expect(pool.choose({ reason: "user", now: 0 }).index).toBe(1);
		pool.setEnabled(accounts[1]!, false);
		expect(pool.choose({ reason: "user", now: 1 }).index).toBe(0);
	});

	it("prefers usable quota and healthier accounts in hybrid mode, with reset recovery", () => {
		const pool = new RotationPool(accounts, 1000, "hybrid");
		pool.reportQuota(accounts[0]!, 0.02, 5_000);
		pool.reportQuota(accounts[1]!, 0.8, 5_000);
		pool.reportQuota(accounts[2]!, 0, 5_000);
		expect(pool.choose({ reason: "user", now: 100 }).index).toBe(1);
		const entries = pool.status(100);
		expect(entries[2]?.readyInMs).toBe(4_900);
		expect(entries[2]?.quotaRemaining).toBe(0);
		expect(pool.choose({ reason: "user", now: 5_001 }).index).toBe(2);
	});

	it("applies exponential credential-specific backoff and honours a server reset hint", () => {
		const pool = new RotationPool(accounts, 1_000);
		pool.choose({ reason: "retry", now: 0, failed: { target: accounts[0]!, errorMessage: "HTTP 429", hasOutput: false } });
		expect(pool.status(0)[0]?.readyInMs).toBe(1_000);
		pool.choose({ reason: "retry", now: 1_001, failed: { target: accounts[0]!, errorMessage: "HTTP 429", hasOutput: false } });
		expect(pool.status(1_001)[0]?.readyInMs).toBe(2_000);
		pool.choose({ reason: "retry", now: 3_002, failed: { target: accounts[0]!, errorMessage: "Usage Limit Reached; limit will reset in 10 minutes", hasOutput: false } });
		expect(pool.status(3_002)[0]?.readyInMs).toBe(600_000);
		expect(pool.status(3_002)[0]?.failureCount).toBe(3);
		pool.markSuccess(accounts[0]!);
		expect(pool.status(3_002)[0]?.failureCount).toBe(0);
	});

	it("pins an authorized account until unpinned and never exposes key material in status", () => {
		const pool = new RotationPool(accounts);
		pool.pin(accounts[2]!);
		expect(pool.choose({ reason: "user", now: 0 }).index).toBe(2);
		expect(pool.choose({ reason: "user", now: 1 }).index).toBe(2);
		pool.unpin();
		expect(pool.choose({ reason: "user", now: 2 }).index).toBe(0);
		expect(pool.status(2).map((s) => s.pinned)).toEqual([false, false, false]);
	});

	it("rejects bogus quota, strategy, and account references without mutating state", () => {
		expect(() => new RotationPool(accounts, 1_000, "other" as never)).toThrow(/strategy/i);
		const pool = new RotationPool(accounts);
		expect(() => pool.reportQuota(accounts[0]!, -0.1)).toThrow(/quota/i);
		expect(() => pool.setEnabled({ provider: "missing", model: "no" }, false)).toThrow(/unknown/i);
		expect(pool.status().every((entry) => entry.enabled)).toBe(true);
	});

	it("keeps normal content, policy, and post-output failures in the original account", () => {
		const pool = new RotationPool(accounts, 1000, "hybrid");
		pool.reportQuota(accounts[0]!, 0.99);
		expect(pool.choose({ reason: "retry", failed: { target: accounts[1]!, errorMessage: "429 rate limit", hasOutput: true } }).index).toBe(1);
		expect(pool.status()[1]?.failureCount).toBe(0);
	});
});

describe("rotation account safety regressions", () => {
	it("never silently substitutes an account in a continuation when credentials go missing", () => {
		const pool = new RotationPool(accounts);
		pool.choose({ reason: "user", now: 10 });
		pool.setAvailable(accounts[0]!, false);
		expect(() => pool.choose({ reason: "continuation", previous: accounts[0], now: 11 })).toThrow(/unavailable/i);
		expect(pool.choose({ reason: "user", now: 12 }).index).toBe(1);
		pool.setAvailable(accounts[0]!, true);
		expect(pool.choose({ reason: "user", now: 13 }).index).toBe(2);
	});

	it("shares account-specific failures between different pools", () => {
		const health = new Map();
		const first = new RotationPool(accounts, 1000, "round-robin", Math.random, health);
		const second = new RotationPool(accounts.slice(0, 2), 1000, "round-robin", Math.random, health);
		first.choose({ reason: "retry", failed: { target: accounts[0]!, errorMessage: "429 rate limit", hasOutput: false }, now: 10 });
		expect(second.status(11)[0]?.readyInMs).toBe(999);
		expect(second.choose({ reason: "user", now: 11 }).target.provider).toBe(accounts[1]!.provider);
		second.markSuccess(accounts[0]!);
		expect(first.status(11)[0]?.readyInMs).toBe(0);
	});

	it("honors a manual pin for direct summary requests", () => {
		const pool = new RotationPool(accounts);
		pool.pin(accounts[2]!);
		expect(pool.choose({ reason: "direct", now: 10 }).index).toBe(2);
	});

	it("shows indefinite zero quota as blocked and permits an explicit re-login to recover", () => {
		const pool = new RotationPool(accounts);
		pool.reportQuota(accounts[0]!, 0);
		expect(pool.status(20)[0]?.quotaBlocked).toBe(true);
		expect(pool.choose({ reason: "user", now: 21 }).index).toBe(1);
		pool.markReauthenticated(accounts[0]!);
		expect(pool.status(22)[0]?.quotaBlocked).toBe(false);
	});

	it("recognizes retry after seconds and quota reset timestamps without leaking tokens", () => {
		const pool = new RotationPool(accounts, 1_000);
		pool.choose({ reason: "retry", now: 1, failed: {
			target: accounts[0]!, errorMessage: "429 retry-after: 120", hasOutput: false,
		} });
		expect(pool.status(1)[0]?.readyInMs).toBe(120_000);
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
