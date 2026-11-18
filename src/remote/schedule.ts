import { jwtExpiresAt } from "../auth/jwt.ts";
import type { StoredTokens } from "../auth/store.ts";
import { REFRESH_INTERVAL_MS, REFRESH_WINDOW_MS } from "../constants.ts";

/**
 * When a vault refreshes its ChatGPT tokens.
 *
 * Two triggers share these rules. A call that needs the tokens refreshes them
 * first when {@link needsRefresh} says so. Independently, the vault's alarm
 * refreshes them at {@link backgroundRefreshAt} with no client involved, so a
 * sign-in stays valid at OpenAI however long the client stays away.
 */

/**
 * Rotate the ChatGPT refresh token at least this often, even when the access
 * token is still valid, so the sign-in never goes stale at OpenAI. Codex
 * itself refreshes after 8 days.
 */
export const KEEP_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** The background refresh renews an access token this long before it expires. */
export const BACKGROUND_LEAD_MS = 60 * 60 * 1000;
/** Never schedule two background refreshes closer together than this. */
export const MIN_BACKGROUND_GAP_MS = 5 * 1000;
/** A background refresh that fails for a passing reason is retried after this long, doubling each time. */
export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/** True when a call must refresh the tokens before using them. */
export function needsRefresh(tokens: StoredTokens, now = Date.now()): boolean {
	const last = tokens.lastRefresh ? Date.parse(tokens.lastRefresh) : Number.NaN;
	if (Number.isFinite(last) && last < now - KEEP_FRESH_MS) return true;
	const expiresAt = jwtExpiresAt(tokens.accessToken);
	if (expiresAt !== undefined) return expiresAt <= now + REFRESH_WINDOW_MS;
	return Number.isFinite(last) && last < now - REFRESH_INTERVAL_MS;
}

/**
 * When the vault should next refresh these tokens by itself, in epoch
 * milliseconds: {@link KEEP_FRESH_MS} after the last refresh, or ahead of the
 * access token's expiry if that comes first. "Ahead" is an hour, or half the
 * token's life for a token that lives less than two hours.
 */
export function backgroundRefreshAt(tokens: StoredTokens, now = Date.now()): number {
	const last = tokens.lastRefresh ? Date.parse(tokens.lastRefresh) : Number.NaN;
	const since = Number.isFinite(last) ? last : now;
	let due = since + KEEP_FRESH_MS;
	const expiresAt = jwtExpiresAt(tokens.accessToken);
	if (expiresAt !== undefined && expiresAt > since) {
		due = Math.min(due, expiresAt - Math.min(BACKGROUND_LEAD_MS, (expiresAt - since) / 2));
	}
	return Math.max(due, since + MIN_BACKGROUND_GAP_MS);
}

/** How long to wait before retrying after `failures` background refreshes in a row have failed. */
export function retryDelay(failures: number): number {
	return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}
