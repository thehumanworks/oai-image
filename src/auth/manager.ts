import { ENV, REFRESH_INTERVAL_MS, REFRESH_WINDOW_MS } from "../constants.ts";
import { AuthRequiredError } from "../errors.ts";
import { type BrowserLogin, type BrowserLoginOptions, startBrowserLogin } from "./browser-login.ts";
import { type DeviceLogin, type DeviceLoginOptions, startDeviceLogin } from "./device-login.ts";
import { jwtExpiresAt, readIdentity, type TokenIdentity } from "./jwt.ts";
import { type OAuthConfig, refreshTokens, type ResolvedOAuthConfig, resolveOAuthConfig, revokeTokens } from "./oauth.ts";
import { codexAuthFile, FileTokenStore, type StoredTokens, type TokenStore } from "./store.ts";

/** What a request needs to authenticate against the ChatGPT backend. */
export interface ResolvedAuth {
	accessToken: string;
	/** Sent as `chatgpt-account-id`. */
	accountId?: string;
	identity: TokenIdentity;
}

export interface GetAuthOptions {
	/**
	 * An access token the backend just answered 401 to. Forces a refresh unless
	 * another process has already replaced it.
	 */
	rejectedAccessToken?: string;
	/**
	 * For providers whose lookup can be slow. `AuthManager` ignores it: a token
	 * refresh always runs to completion so the rotated refresh token is saved.
	 */
	signal?: AbortSignal;
}

/** Supplies credentials for each request. Implement this to plug in your own token source. */
export interface AuthProvider {
	getAuth(options?: GetAuthOptions): Promise<ResolvedAuth>;
}

export interface AuthStatus {
	loggedIn: boolean;
	/** Where the credentials are kept. */
	location: string;
	identity?: TokenIdentity;
	accessTokenExpiresAt?: Date;
	lastRefresh?: Date;
}

export interface AuthManagerOptions extends OAuthConfig {
	/** Default: `~/.oai-image/auth.json`. */
	store?: TokenStore;
	/** Clock, for tests. */
	now?: () => number;
}

const NOT_LOGGED_IN = "Not signed in. Run `oai-image login` to sign in with ChatGPT.";

/** Owns a ChatGPT login: persists tokens, refreshes them before they expire, and signs in or out. */
export class AuthManager implements AuthProvider {
	readonly store: TokenStore;
	readonly #config: ResolvedOAuthConfig;
	readonly #now: () => number;
	#refreshing: Promise<StoredTokens> | undefined;

	constructor(options: AuthManagerOptions = {}) {
		this.store = options.store ?? new FileTokenStore();
		this.#config = resolveOAuthConfig(options);
		this.#now = options.now ?? Date.now;
	}

	async getAuth(options: GetAuthOptions = {}): Promise<ResolvedAuth> {
		let tokens = await this.store.load();
		if (!tokens) throw new AuthRequiredError(NOT_LOGGED_IN);
		const rejected = options.rejectedAccessToken !== undefined && options.rejectedAccessToken === tokens.accessToken;
		if (rejected || this.#needsRefresh(tokens)) {
			tokens = await this.#refresh(tokens, rejected);
		}
		return toResolvedAuth(tokens);
	}

	async status(): Promise<AuthStatus> {
		const tokens = await this.store.load();
		if (!tokens) return { loggedIn: false, location: this.store.location };
		const expiresAt = jwtExpiresAt(tokens.accessToken);
		const lastRefresh = tokens.lastRefresh ? new Date(tokens.lastRefresh) : undefined;
		return {
			loggedIn: true,
			location: this.store.location,
			identity: readIdentity(tokens.accessToken, tokens.idToken),
			accessTokenExpiresAt: expiresAt === undefined ? undefined : new Date(expiresAt),
			lastRefresh: lastRefresh && !Number.isNaN(lastRefresh.getTime()) ? lastRefresh : undefined,
		};
	}

	/** Begin the browser sign-in. Tokens are saved when `wait()` resolves. */
	async startBrowserLogin(options: Omit<BrowserLoginOptions, keyof OAuthConfig> = {}): Promise<BrowserLogin> {
		const login = await startBrowserLogin({ ...options, ...this.#config });
		const saved = login.wait().then(tokens => this.saveLogin(tokens));
		saved.catch(() => undefined);
		return { ...login, wait: () => saved };
	}

	/** Begin the device-code sign-in. Tokens are saved when `wait()` resolves. */
	async startDeviceLogin(options: Omit<DeviceLoginOptions, keyof OAuthConfig> = {}): Promise<DeviceLogin> {
		const login = await startDeviceLogin({ ...options, ...this.#config });
		let saved: Promise<StoredTokens> | undefined;
		return {
			...login,
			wait: () => {
				saved ??= login.wait().then(tokens => this.saveLogin(tokens));
				return saved;
			},
		};
	}

	async saveLogin(tokens: StoredTokens): Promise<StoredTokens> {
		await this.store.withLock(() => this.store.save(tokens));
		return tokens;
	}

	/**
	 * Forget the login. Unless `revoke` is false, the refresh token is also
	 * revoked at the issuer (best effort).
	 *
	 * @returns whether there was a login to remove.
	 */
	async logout(options: { revoke?: boolean } = {}): Promise<boolean> {
		const tokens = await this.store.load();
		if (!tokens) return false;
		await this.store.withLock(() => this.store.clear());
		if (options.revoke !== false) await revokeTokens(this.#config, tokens);
		return true;
	}

	#needsRefresh(tokens: StoredTokens): boolean {
		const expiresAt = jwtExpiresAt(tokens.accessToken);
		if (expiresAt !== undefined) return expiresAt <= this.#now() + REFRESH_WINDOW_MS;
		if (!tokens.lastRefresh) return false;
		const last = Date.parse(tokens.lastRefresh);
		return Number.isFinite(last) && last < this.#now() - REFRESH_INTERVAL_MS;
	}

	/**
	 * One refresh at a time per process, and one at a time across processes via the store lock.
	 *
	 * Deliberately not cancellable: once the issuer has rotated the refresh
	 * token, the replacement must reach the store or the login is lost. The
	 * request has its own timeout.
	 */
	#refresh(observed: StoredTokens, rejected: boolean): Promise<StoredTokens> {
		this.#refreshing ??= this.store
			.withLock(async () => {
				// Another process may have refreshed while this one waited for the
				// lock. Its refresh token replaced ours, so reusing ours would kill
				// the login.
				const latest = await this.store.load();
				if (!latest) throw new AuthRequiredError(NOT_LOGGED_IN);
				const replaced = latest.accessToken !== observed.accessToken;
				if (replaced && !this.#needsRefresh(latest)) return latest;
				if (!replaced && !rejected && !this.#needsRefresh(latest)) return latest;
				const next = await refreshTokens(this.#config, latest);
				await this.store.save(next);
				return next;
			})
			.finally(() => {
				this.#refreshing = undefined;
			});
		return this.#refreshing;
	}
}

/** A fixed access token with no refresh, for callers that obtain tokens elsewhere. */
export class StaticTokenAuth implements AuthProvider {
	readonly #auth: ResolvedAuth;

	constructor(accessToken: string, accountId?: string) {
		const identity = readIdentity(accessToken);
		this.#auth = { accessToken, accountId: accountId ?? identity.accountId, identity };
	}

	async getAuth(options: GetAuthOptions = {}): Promise<ResolvedAuth> {
		if (options.rejectedAccessToken === this.#auth.accessToken) {
			throw new AuthRequiredError(
				"The backend rejected the supplied access token, and a fixed token cannot be refreshed.",
				"rejected",
			);
		}
		return this.#auth;
	}
}

/**
 * The credential source used when none is given:
 *
 * 1. Codex CLI's `auth.json`, when `useCodexAuth` is passed;
 * 2. `OAI_IMAGE_ACCESS_TOKEN` (fixed token, never refreshed);
 * 3. Codex CLI's `auth.json`, when `OAI_IMAGE_USE_CODEX_AUTH=1`;
 * 4. this package's own login at `~/.oai-image/auth.json`.
 */
export function defaultAuth(options: AuthManagerOptions & { useCodexAuth?: boolean } = {}): AuthProvider {
	const token = process.env[ENV.accessToken]?.trim();
	// An explicit store or an explicit request for Codex's login outranks the environment.
	if (token && !options.store && !options.useCodexAuth) {
		return new StaticTokenAuth(token, process.env[ENV.accountId]?.trim() || undefined);
	}
	return defaultAuthManager(options);
}

/** Like {@link defaultAuth}, but always a manager (login, logout and status need one). */
export function defaultAuthManager(options: AuthManagerOptions & { useCodexAuth?: boolean } = {}): AuthManager {
	const { useCodexAuth, ...rest } = options;
	if (rest.store) return new AuthManager(rest);
	const shared = useCodexAuth ?? isTruthy(process.env[ENV.useCodexAuth]);
	return new AuthManager({
		...rest,
		store: shared ? new FileTokenStore(codexAuthFile(), { shared: true }) : new FileTokenStore(),
	});
}

function toResolvedAuth(tokens: StoredTokens): ResolvedAuth {
	const identity = readIdentity(tokens.accessToken, tokens.idToken);
	// The token's own claim names the workspace it is valid for.
	return { accessToken: tokens.accessToken, accountId: identity.accountId ?? tokens.accountId, identity };
}

function isTruthy(value: string | undefined): boolean {
	return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
