import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ENV } from "../constants.ts";
import { OaiImageError } from "../errors.ts";

/** ChatGPT OAuth tokens as this package holds them. */
export interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	/** Workspace id, from the `chatgpt_account_id` claim. */
	accountId?: string;
	/** ISO timestamp of the last login or refresh. */
	lastRefresh?: string;
}

/** Where tokens live. Implement this to keep them in a keychain or secret manager. */
export interface TokenStore {
	/** Human-readable location, shown by `oai-image status`. */
	readonly location: string;
	load(): Promise<StoredTokens | undefined>;
	save(tokens: StoredTokens): Promise<void>;
	clear(): Promise<void>;
	/**
	 * Run `task` while holding a lock that other processes sharing this store
	 * respect. A refresh token is single-use, so two processes refreshing at
	 * once would invalidate the login.
	 */
	withLock<T>(task: () => Promise<T>): Promise<T>;
}

/** Directory holding this package's state: `$OAI_IMAGE_HOME` or `~/.oai-image`. */
export function defaultHomeDir(): string {
	const override = process.env[ENV.home]?.trim();
	return override ? path.resolve(override) : path.join(os.homedir(), ".oai-image");
}

export function defaultAuthFile(): string {
	return path.join(defaultHomeDir(), "auth.json");
}

/** Codex CLI's credential file: `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. */
export function codexAuthFile(): string {
	const override = process.env.CODEX_HOME?.trim();
	return path.join(override ? path.resolve(override) : path.join(os.homedir(), ".codex"), "auth.json");
}

export interface FileTokenStoreOptions {
	/**
	 * The file belongs to another tool (Codex CLI). `clear()` is refused so
	 * logging out here cannot log the user out there.
	 */
	shared?: boolean;
	/** How long to wait for another process's lock. */
	lockTimeoutMs?: number;
	/** Age after which a leftover lock file is treated as abandoned. */
	lockStaleMs?: number;
}

/**
 * Tokens in a JSON file using the Codex CLI `auth.json` layout
 * (`{ auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }`).
 *
 * Sharing the layout lets one implementation serve this package's own file
 * and, when asked, Codex's file. Fields this package does not know are kept
 * on every write.
 */
export class FileTokenStore implements TokenStore {
	readonly location: string;
	readonly shared: boolean;
	readonly #lockTimeoutMs: number;
	readonly #lockStaleMs: number;

	constructor(file: string = defaultAuthFile(), options: FileTokenStoreOptions = {}) {
		this.location = path.resolve(file);
		this.shared = options.shared ?? false;
		this.#lockTimeoutMs = options.lockTimeoutMs ?? 90_000;
		this.#lockStaleMs = options.lockStaleMs ?? 60_000;
	}

	async load(): Promise<StoredTokens | undefined> {
		const document = await this.#read();
		const tokens = record(document?.tokens);
		if (!tokens) return undefined;
		const accessToken = str(tokens.access_token);
		const refreshToken = str(tokens.refresh_token);
		if (!accessToken || !refreshToken) return undefined;
		return {
			accessToken,
			refreshToken,
			idToken: str(tokens.id_token),
			accountId: str(tokens.account_id),
			lastRefresh: str(document?.last_refresh),
		};
	}

	async save(tokens: StoredTokens): Promise<void> {
		const document = (await this.#read()) ?? {};
		const previous = record(document.tokens) ?? {};
		const next: Record<string, unknown> = {
			...previous,
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
		};
		if (tokens.idToken) next.id_token = tokens.idToken;
		if (tokens.accountId) next.account_id = tokens.accountId;
		const merged: Record<string, unknown> = {
			...document,
			tokens: next,
			last_refresh: tokens.lastRefresh ?? new Date().toISOString(),
		};
		if (!this.shared) merged.auth_mode = "chatgpt";
		await this.#write(merged);
	}

	async clear(): Promise<void> {
		if (this.shared) {
			throw new OaiImageError(
				`${this.location} belongs to the Codex CLI. Run \`codex logout\` to sign out of it.`,
			);
		}
		await fs.rm(this.location, { force: true });
	}

	async withLock<T>(task: () => Promise<T>): Promise<T> {
		const lockFile = `${this.location}.lock`;
		await fs.mkdir(path.dirname(this.location), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + this.#lockTimeoutMs;
		for (;;) {
			try {
				const handle = await fs.open(lockFile, "wx", 0o600);
				await handle.writeFile(`${process.pid}\n`);
				await handle.close();
				break;
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
				const stat = await fs.stat(lockFile).catch(() => undefined);
				if (!stat || Date.now() - stat.mtimeMs > this.#lockStaleMs) {
					await fs.rm(lockFile, { force: true });
					continue;
				}
				if (Date.now() >= deadline) {
					throw new OaiImageError(`Timed out waiting for the credential lock at ${lockFile}`);
				}
				await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
			}
		}
		try {
			return await task();
		} finally {
			await fs.rm(lockFile, { force: true });
		}
	}

	async #read(): Promise<Record<string, unknown> | undefined> {
		let text: string;
		try {
			text = await fs.readFile(this.location, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) return undefined;
			throw error;
		}
		try {
			return record(JSON.parse(text));
		} catch (cause) {
			throw new OaiImageError(`${this.location} is not valid JSON`, { cause });
		}
	}

	/** Readers must see the whole old or the whole new document, so write aside and rename. */
	async #write(document: Record<string, unknown>): Promise<void> {
		const dir = path.dirname(this.location);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const temp = path.join(dir, `.${path.basename(this.location)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
			await fs.rename(temp, this.location);
		} catch (error) {
			await fs.rm(temp, { force: true });
			throw error;
		}
	}
}

/** Tokens held in memory only. For tests and for callers that persist tokens themselves. */
export class MemoryTokenStore implements TokenStore {
	readonly location = "memory";
	#tokens: StoredTokens | undefined;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(tokens?: StoredTokens) {
		this.#tokens = tokens ? { ...tokens } : undefined;
	}

	async load(): Promise<StoredTokens | undefined> {
		return this.#tokens ? { ...this.#tokens } : undefined;
	}

	async save(tokens: StoredTokens): Promise<void> {
		this.#tokens = { ...tokens, lastRefresh: tokens.lastRefresh ?? new Date().toISOString() };
	}

	async clear(): Promise<void> {
		this.#tokens = undefined;
	}

	withLock<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(task, task);
		this.#tail = run.catch(() => undefined);
		return run;
	}
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
