import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredTokens } from "../src/auth/store.ts";
import { fromBase64url, base64url, hmacSha256, newKeyMaterial, randomToken, safeEqual, seal, unseal } from "../src/remote/crypto.ts";
import {
	backgroundRefreshAt,
	KEEP_FRESH_MS,
	MIN_BACKGROUND_GAP_MS,
	needsRefresh,
	RETRY_BASE_MS,
	RETRY_MAX_MS,
	retryDelay,
} from "../src/remote/schedule.ts";
import { makeJwt } from "./helpers.ts";

test("remote crypto: sealed data opens only with the same key and context", async () => {
	const key = newKeyMaterial();
	const sealed = await seal(key, '{"refreshToken":"secret"}', "vault/a");
	assert.doesNotMatch(JSON.stringify(sealed), /secret/);
	assert.equal(await unseal(key, sealed, "vault/a"), '{"refreshToken":"secret"}');
	await assert.rejects(unseal(newKeyMaterial(), sealed, "vault/a"));
	await assert.rejects(unseal(key, sealed, "vault/b"));
	const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("A") ? "BB" : "AA") };
	await assert.rejects(unseal(key, tampered, "vault/a"));
});

test("remote crypto: tokens are random and base64url round-trips", async () => {
	assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(randomToken(), randomToken());
	const bytes = crypto.getRandomValues(new Uint8Array(57));
	assert.deepEqual(fromBase64url(base64url(bytes)), bytes);
	assert.equal(safeEqual("abc", "abc"), true);
	assert.equal(safeEqual("abc", "abd"), false);
	assert.equal(safeEqual("abc", "abcd"), false);
	assert.equal(await hmacSha256("k", "m"), await hmacSha256("k", "m"));
	assert.notEqual(await hmacSha256("k", "m"), await hmacSha256("k2", "m"));
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tokensAt(now: number, options: { ageMs?: number; expiresInMs?: number } = {}): StoredTokens {
	return {
		accessToken:
			options.expiresInMs === undefined ? "not-a-jwt" : makeJwt({ exp: Math.floor((now + options.expiresInMs) / 1000) }),
		refreshToken: "refresh",
		lastRefresh: new Date(now - (options.ageMs ?? 0)).toISOString(),
	};
}

test("remote schedule: the background refresh runs weekly, or ahead of the access token's expiry", () => {
	const now = Date.parse("2026-11-18T00:00:00Z");
	// A 10-day ChatGPT access token: the weekly rotation comes first.
	assert.equal(backgroundRefreshAt(tokensAt(now, { expiresInMs: 10 * DAY }), now), now + KEEP_FRESH_MS);
	// A 3-day token: an hour before it expires.
	assert.equal(backgroundRefreshAt(tokensAt(now, { expiresInMs: 3 * DAY }), now), now + 3 * DAY - HOUR);
	// A token shorter than two hours: at half its life, so refreshes never chase each other.
	assert.equal(backgroundRefreshAt(tokensAt(now, { expiresInMs: HOUR }), now), now + HOUR / 2);
	// A token without a readable expiry: the weekly rotation.
	assert.equal(backgroundRefreshAt(tokensAt(now), now), now + KEEP_FRESH_MS);
	// Counted from the last refresh, not from now.
	assert.equal(backgroundRefreshAt(tokensAt(now, { ageMs: 2 * DAY, expiresInMs: 8 * DAY }), now), now + 5 * DAY);
	// Never immediately after a refresh, even for a token that is already expiring.
	assert.equal(backgroundRefreshAt(tokensAt(now, { expiresInMs: 2000 }), now), now + MIN_BACKGROUND_GAP_MS);
	assert.equal(backgroundRefreshAt(tokensAt(now, { expiresInMs: -HOUR }), now), now + KEEP_FRESH_MS);
	// An overdue vault is due at once.
	assert.ok(backgroundRefreshAt(tokensAt(now, { ageMs: 30 * DAY, expiresInMs: -20 * DAY }), now) < now);
});

test("remote schedule: a call refreshes tokens that are stale or about to expire", () => {
	const now = Date.parse("2026-11-18T00:00:00Z");
	assert.equal(needsRefresh(tokensAt(now, { expiresInMs: 10 * DAY }), now), false);
	assert.equal(needsRefresh(tokensAt(now, { expiresInMs: 4 * 60 * 1000 }), now), true);
	assert.equal(needsRefresh(tokensAt(now, { ageMs: 8 * DAY, expiresInMs: 2 * DAY }), now), true);
	// The background refresh is always due no later than a call would refresh.
	for (const expiresInMs of [10 * DAY, 3 * DAY, HOUR, 10 * 60 * 1000]) {
		const tokens = tokensAt(now, { expiresInMs });
		const due = backgroundRefreshAt(tokens, now);
		assert.equal(needsRefresh(tokens, due - 1000), false, `not yet needed just before the background refresh (${expiresInMs})`);
	}
});

test("remote schedule: failed background refreshes back off up to six hours", () => {
	assert.equal(retryDelay(1), RETRY_BASE_MS);
	assert.equal(retryDelay(2), 2 * RETRY_BASE_MS);
	assert.equal(retryDelay(5), 16 * RETRY_BASE_MS);
	assert.equal(retryDelay(50), RETRY_MAX_MS);
});
