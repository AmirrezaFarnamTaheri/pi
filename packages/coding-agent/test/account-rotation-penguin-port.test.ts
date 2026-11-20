/**
 * Regression cases adapted from Penguin Harness's credential rotation,
 * quota detection, and provider gateway behavior.
 */
import { describe, expect, it } from "vitest";
import {
	classifyCredentialFailure,
	quotaResetDelayMs,
	RotationPool,
	summarizeRotationHealth,
} from "../src/extensions/account-rotation-policy.ts";

const claude = { provider: "account-one", model: "claude" };
const gemini = { provider: "account-one", model: "gemini" };
const backup = { provider: "account-two", model: "claude" };

describe("Penguin quota and credential failure classification in Pi", () => {
	it("distinguishes exhausted billing quota from transient rate limits", () => {
		expect(classifyCredentialFailure("HTTP 429 Too Many Requests")).toBe("rate-limit");
		expect(classifyCredentialFailure("RESOURCE_EXHAUSTED (code 429)")).toBe("rate-limit");
		expect(classifyCredentialFailure("error code: insufficient_quota")).toBe("quota");
		expect(classifyCredentialFailure("billing_hard_limit_reached")).toBe("quota");
		expect(classifyCredentialFailure("daily quota exhausted")).toBe("quota");
		expect(classifyCredentialFailure("HTTP 403 quota_exceeded")).toBe("quota");
	});

	it("never treats a bare 403, invalid request, or content-policy rejection as a credential failure", () => {
		expect(classifyCredentialFailure("HTTP 403 Forbidden")).toBeUndefined();
		expect(classifyCredentialFailure("HTTP 400 context_length_exceeded")).toBeUndefined();
		expect(classifyCredentialFailure("HTTP 422 invalid request")).toBeUndefined();
		expect(classifyCredentialFailure("HTTP 429 content policy violation")).toBeUndefined();
		expect(classifyCredentialFailure("HTTP 401 invalid_api_key")).toBe("auth");
		expect(classifyCredentialFailure("HTTP 429 Too Many Requests: limit 401 requests per minute")).toBe("rate-limit");
		expect(classifyCredentialFailure("HTTP 429 rate limit exceeded: 500 requests per minute")).toBe("rate-limit");
		expect(classifyCredentialFailure("HTTP 429 quota_exceeded; reset in 500 seconds")).toBe("quota");
		expect(classifyCredentialFailure("invalid_token")).toBe("auth");
	});

	it("extracts provider reset hints and caps them to one day", () => {
		expect(quotaResetDelayMs("Retry-After: 120")).toBe(120_000);
		expect(quotaResetDelayMs("Resets in 1h2m3s")).toBe(3_723_000);
		expect(quotaResetDelayMs("reset_after: 1.5s")).toBe(1_500);
		expect(quotaResetDelayMs("limit will reset in 2 hours and 3 minutes")).toBe(7_380_000);
		expect(quotaResetDelayMs("Retry-After: 9999999999999")).toBe(86_400_000);
		expect(quotaResetDelayMs("Retry-After: zero")).toBeUndefined();
	});
});

describe("Penguin per-model credential health in Pi rotation", () => {
	it("parks a throttled model without disabling a different model on the same account", () => {
		const health = new Map();
		const claudePool = new RotationPool([claude, backup], 1_000, "round-robin", Math.random, health);
		const geminiPool = new RotationPool([gemini], 1_000, "round-robin", Math.random, health);

		expect(
			claudePool.choose({
				reason: "retry",
				now: 100,
				failed: { target: claude, errorMessage: "HTTP 429 Too Many Requests", hasOutput: false },
			}).target,
		).toEqual(backup);
		expect(claudePool.status(101)[0]?.readyInMs).toBe(999);
		expect(geminiPool.status(101)[0]?.readyInMs).toBe(0);
		expect(geminiPool.choose({ reason: "user", now: 102 }).target).toEqual(gemini);
	});

	it("shares an invalid credential quarantine across models and clears it on reauthentication", () => {
		const health = new Map();
		const claudePool = new RotationPool([claude, backup], 1_000, "round-robin", Math.random, health);
		const geminiPool = new RotationPool([gemini], 1_000, "round-robin", Math.random, health);
		expect(
			claudePool.choose({
				reason: "retry",
				now: 0,
				failed: { target: claude, errorMessage: "401 invalid_api_key", hasOutput: false },
			}).target,
		).toEqual(backup);
		expect(claudePool.status(10)[0]?.authRejected).toBe(true);
		expect(geminiPool.status(10)[0]?.authRejected).toBe(true);
		expect(geminiPool.status(10)[0]?.readyInMs).toBe(Number.POSITIVE_INFINITY);
		expect(() => geminiPool.choose({ reason: "user", now: 10 })).toThrow(/cooling down|exhausted|disabled/i);
		geminiPool.markReauthenticated(gemini);
		expect(claudePool.status(11)[0]?.authRejected).toBe(false);
		expect(geminiPool.choose({ reason: "user", now: 11 }).target).toEqual(gemini);
	});

	it("keeps authentication request metrics scoped to the failed model", () => {
		const health = new Map();
		const claudePool = new RotationPool([claude, backup], 1_000, "round-robin", Math.random, health);
		const geminiPool = new RotationPool([gemini], 1_000, "round-robin", Math.random, health);
		claudePool.choose({
			reason: "retry",
			now: 100,
			failed: { target: claude, errorMessage: "HTTP 401 invalid_api_key", hasOutput: false },
		});
		expect(claudePool.status(101)[0]?.failedRequests).toBe(1);
		expect(claudePool.status(101)[0]?.lastFailureAt).toBe(100);
		expect(geminiPool.status(101)[0]?.authRejected).toBe(true);
		expect(geminiPool.status(101)[0]?.failedRequests).toBe(0);
		expect(geminiPool.status(101)[0]?.lastFailureAt).toBeUndefined();
	});

	it("records authentication rejection on the original continuation identity without replaying on another account", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		expect(() =>
			pool.choose({
				reason: "retry",
				previous: claude,
				active: claude,
				now: 100,
				failed: { target: claude, errorMessage: "HTTP 401 invalid_api_key", hasOutput: false },
			}),
		).toThrow(/original account failed during continuation/i);
		expect(pool.status(101)[0]).toMatchObject({ authRejected: true, failedRequests: 1 });
		expect(pool.status(101)[1]).toMatchObject({ authRejected: false, failedRequests: 0 });
		expect(pool.choose({ reason: "user", now: 102 }).target).toEqual(backup);
	});

	it("marks a continuation rate limit while blocking cross-account retry", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		expect(() =>
			pool.choose({
				reason: "retry",
				previous: claude,
				now: 100,
				failed: { target: claude, errorMessage: "HTTP 429 Too Many Requests", hasOutput: false },
			}),
		).toThrow(/original account failed during continuation/i);
		expect(pool.status(101)[0]).toMatchObject({ readyInMs: 999, failedRequests: 1 });
		expect(pool.status(101)[1]).toMatchObject({ readyInMs: 0, failedRequests: 0 });
	});

	it("holds a tool continuation on its original identity after an empty overload", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		const result = pool.choose({
			reason: "retry",
			previous: claude,
			active: claude,
			now: 100,
			failed: { target: claude, errorMessage: "HTTP 503 service unavailable", hasOutput: false },
		});
		expect(result.target).toEqual(claude);
		expect(pool.status(101)[0]?.failureCount).toBe(0);
	});

	it("blocks spent quota without a reset hint until the user resets health or logs in again", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		expect(
			pool.choose({
				reason: "retry",
				now: 5,
				failed: { target: claude, errorMessage: "insufficient_quota", hasOutput: false },
			}).target,
		).toEqual(backup);
		expect(pool.status(10)[0]?.quotaBlocked).toBe(true);
		expect(pool.status(10)[0]?.readyInMs).toBe(Number.POSITIVE_INFINITY);
		pool.markReauthenticated(claude);
		expect(pool.status(11)[0]?.quotaBlocked).toBe(false);
	});

	it("automatically recovers quota after the provider's reported reset window", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		pool.choose({
			reason: "retry",
			now: 100,
			failed: {
				target: claude,
				errorMessage: "HTTP 429 quota_exceeded; Resets in 30s",
				hasOutput: false,
			},
		});
		expect(pool.status(100)[0]?.readyInMs).toBe(30_000);
		expect(pool.status(30_101)[0]?.readyInMs).toBe(0);
		expect(pool.status(30_101)[0]?.quotaBlocked).toBe(false);
	});

	it("does not poison account health after provider outages, but may try a different available account", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		expect(
			pool.choose({
				reason: "retry",
				now: 100,
				failed: { target: claude, errorMessage: "HTTP 503 service unavailable", hasOutput: false },
			}).target,
		).toEqual(backup);
		expect(pool.status(101)[0]?.failureCount).toBe(0);
		expect(pool.status(101)[0]?.readyInMs).toBe(0);
	});

	it("keeps cooldown and failover from moving output-producing or pinned conversations", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		expect(
			pool.choose({
				reason: "retry",
				now: 100,
				failed: { target: claude, errorMessage: "quota_exceeded", hasOutput: true },
			}).target,
		).toEqual(claude);
		expect(pool.status(100)[0]?.quotaBlocked).toBe(false);
		pool.pin(claude);
		expect(() =>
			pool.choose({
				reason: "retry",
				now: 101,
				failed: { target: claude, errorMessage: "HTTP 429", hasOutput: false },
			}),
		).toThrow(/pinned account/i);
	});

	it("summarizes fleet readiness without exposing credentials or miscounting blocked states", () => {
		const pool = new RotationPool([claude, backup], 1000);
		expect(summarizeRotationHealth(pool.status(0))).toEqual({
			total: 2,
			ready: 2,
			cooling: 0,
			quotaBlocked: 0,
			authRejected: 0,
			disabled: 0,
			unavailable: 0,
		});
		pool.reportQuota(claude, 0);
		pool.setEnabled(backup, false);
		expect(summarizeRotationHealth(pool.status(1))).toEqual({
			total: 2,
			ready: 0,
			cooling: 0,
			quotaBlocked: 1,
			authRejected: 0,
			disabled: 1,
			unavailable: 0,
		});
	});

	it("reauthentication clears cooldowns across every model of the same account", () => {
		const health = new Map();
		const claudePool = new RotationPool([claude, backup], 1000, "round-robin", Math.random, health);
		const geminiPool = new RotationPool([gemini, backup], 1000, "round-robin", Math.random, health);
		for (const [pool, target] of [
			[claudePool, claude],
			[geminiPool, gemini],
		] as const) {
			pool.choose({
				reason: "retry",
				now: 0,
				failed: { target, errorMessage: "429 rate limit", hasOutput: false },
			});
			expect(pool.status(1)[0]?.readyInMs).toBe(999);
		}
		claudePool.markReauthenticated(claude);
		expect(claudePool.status(2)[0]?.readyInMs).toBe(0);
		expect(geminiPool.status(2)[0]?.readyInMs).toBe(0);
	});

	it("records successful and failed requests as nonsecret health counters", () => {
		const pool = new RotationPool([claude, backup], 1_000);
		pool.choose({
			reason: "retry",
			now: 100,
			failed: { target: claude, errorMessage: "429", hasOutput: false },
		});
		pool.markSuccess(claude, 200);
		const record = pool.status(201)[0];
		expect(record?.failureCount).toBe(0);
		expect(record?.failedRequests).toBe(1);
		expect(record?.successfulRequests).toBe(1);
		expect(record?.lastSuccessAt).toBe(200);
		expect(record?.lastFailureAt).toBe(100);
		expect(JSON.stringify(record)).not.toContain("sk-");
	});
});
