import { CODEX_CLIENT_ID, DEFAULT_ISSUER, DEFAULT_ORIGINATOR, ENV, OAUTH_SCOPE } from "../constants.ts";
import { AuthRequiredError, LoginError } from "../errors.ts";
import { readIdentity } from "./jwt.ts";
import type { StoredTokens } from "./store.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Endpoint configuration shared by every auth call. Overridable so tests can point at a local issuer. */
export interface OAuthConfig {
	/** OAuth issuer. Default `https://auth.openai.com`. */
	issuer?: string;
	clientId?: string;
	/** Value of the `originator` authorize parameter. */
	originator?: string;
	fetch?: FetchLike;
}

export interface ResolvedOAuthConfig {
	issuer: string;
	clientId: string;
	originator: string;
	fetch: FetchLike;
}

export function resolveOAuthConfig(config: OAuthConfig = {}): ResolvedOAuthConfig {
	return {
		issuer: (config.issuer ?? process.env[ENV.issuer] ?? DEFAULT_ISSUER).replace(/\/+$/, ""),
		clientId: config.clientId ?? CODEX_CLIENT_ID,
		originator: config.originator ?? process.env[ENV.originator] ?? DEFAULT_ORIGINATOR,
		fetch: config.fetch ?? ((input, init) => fetch(input, init)),
	};
}

const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_TIMEOUT_MS = 45_000;
const REVOKE_TIMEOUT_MS = 10_000;

export function buildAuthorizeUrl(
	config: ResolvedOAuthConfig,
	args: { redirectUri: string; challenge: string; state: string },
): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: args.redirectUri,
		scope: OAUTH_SCOPE,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: config.originator,
		state: args.state,
	});
	return `${config.issuer}/oauth/authorize?${params.toString()}`;
}

/** Trade an authorization code for tokens (form-encoded, public client, PKCE). */
export async function exchangeCodeForTokens(
	config: ResolvedOAuthConfig,
	args: { code: string; verifier: string; redirectUri: string; signal?: AbortSignal },
): Promise<StoredTokens> {
	let response: Response;
	try {
		response = await config.fetch(`${config.issuer}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: config.clientId,
				code: args.code,
				redirect_uri: args.redirectUri,
				code_verifier: args.verifier,
			}).toString(),
			signal: withTimeout(TOKEN_EXCHANGE_TIMEOUT_MS, args.signal),
		});
	} catch (cause) {
		throw new LoginError(`Could not reach the sign-in service: ${describe(cause)}`, "network", { cause });
	}
	const text = await response.text();
	if (!response.ok) {
		const detail = parseTokenEndpointError(text);
		throw new LoginError(
			`Token exchange failed (${response.status}): ${detail.message}`,
			detail.code ?? `http_${response.status}`,
		);
	}
	const body = parseJsonRecord(text);
	const accessToken = str(body?.access_token);
	const refreshToken = str(body?.refresh_token);
	const idToken = str(body?.id_token);
	if (!accessToken || !refreshToken) {
		throw new LoginError("The sign-in service returned no access or refresh token", "invalid_response");
	}
	return {
		accessToken,
		refreshToken,
		idToken,
		accountId: readIdentity(accessToken, idToken).accountId,
		lastRefresh: new Date().toISOString(),
	};
}

/**
 * Get fresh tokens from a refresh token. ChatGPT refresh uses a JSON body.
 *
 * The refresh token is single-use: the response carries its replacement, and
 * the caller must persist the result before anything else can go wrong.
 *
 * @throws AuthRequiredError when the refresh token can never work again.
 */
export async function refreshTokens(
	config: ResolvedOAuthConfig,
	current: StoredTokens,
	signal?: AbortSignal,
): Promise<StoredTokens> {
	let response: Response;
	try {
		response = await config.fetch(`${config.issuer}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: config.clientId,
				grant_type: "refresh_token",
				refresh_token: current.refreshToken,
			}),
			signal: withTimeout(TOKEN_REFRESH_TIMEOUT_MS, signal),
		});
	} catch (cause) {
		throw new LoginError(`Could not reach the sign-in service to refresh the login: ${describe(cause)}`, "network", {
			cause,
		});
	}
	const text = await response.text();
	if (!response.ok) {
		const detail = parseTokenEndpointError(text);
		const code = detail.code?.toLowerCase();
		const again = "Run `oai-image login` to sign in again.";
		if (code === "refresh_token_expired") {
			throw new AuthRequiredError(`Your ChatGPT login has expired. ${again}`, "refresh-expired");
		}
		if (code === "refresh_token_reused") {
			throw new AuthRequiredError(
				`Your ChatGPT login was already refreshed by another program and can no longer be used here. ${again}`,
				"refresh-reused",
			);
		}
		if (code === "refresh_token_invalidated") {
			throw new AuthRequiredError(`Your ChatGPT login was revoked. ${again}`, "refresh-revoked");
		}
		if (response.status === 401 || (response.status === 400 && code === "invalid_grant")) {
			throw new AuthRequiredError(
				`The sign-in service rejected the saved login (${response.status}: ${detail.message}). ${again}`,
				"rejected",
			);
		}
		throw new LoginError(
			`Refreshing the login failed (${response.status}): ${detail.message}`,
			detail.code ?? `http_${response.status}`,
		);
	}
	const body = parseJsonRecord(text);
	if (!body) throw new LoginError("The sign-in service returned an unreadable refresh response", "invalid_response");
	const accessToken = str(body.access_token) ?? current.accessToken;
	const idToken = str(body.id_token) ?? current.idToken;
	return {
		accessToken,
		refreshToken: str(body.refresh_token) ?? current.refreshToken,
		idToken,
		accountId: readIdentity(accessToken, idToken).accountId ?? current.accountId,
		lastRefresh: new Date().toISOString(),
	};
}

/** Best-effort revocation of a login, as `codex logout` does. Never throws. */
export async function revokeTokens(config: ResolvedOAuthConfig, tokens: StoredTokens): Promise<boolean> {
	try {
		const response = await config.fetch(`${config.issuer}/oauth/revoke`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: tokens.refreshToken,
				token_type_hint: "refresh_token",
				client_id: config.clientId,
			}),
			signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
		});
		await response.arrayBuffer().catch(() => undefined);
		return response.ok;
	} catch {
		return false;
	}
}

/** Pull `{ code, message }` out of the several shapes the token endpoint uses for errors. */
export function parseTokenEndpointError(text: string): { code?: string; message: string } {
	const trimmed = text.trim();
	const body = parseJsonRecord(trimmed);
	if (!body) return { message: trimmed.slice(0, 500) || "no response body" };
	const error = body.error;
	if (typeof error === "string") {
		const description = str(body.error_description);
		return { code: error, message: description ? `${error}: ${description}` : error };
	}
	if (typeof error === "object" && error !== null) {
		const nested = error as Record<string, unknown>;
		const code = str(nested.code) ?? str(nested.type);
		const message = str(nested.message) ?? str(nested.error_description);
		return { code, message: [code, message].filter(Boolean).join(": ") || trimmed.slice(0, 500) };
	}
	const code = str(body.code);
	const message = str(body.message) ?? str(body.detail) ?? str(body.error_description);
	return { code, message: message ?? trimmed.slice(0, 500) };
}

export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function describe(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		const inner = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
		return `${error.message}${inner}`;
	}
	return String(error);
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
