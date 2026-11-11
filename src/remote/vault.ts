import { DurableObject } from "cloudflare:workers";
import { readIdentity, jwtExpiresAt } from "../auth/jwt.ts";
import type { ResolvedAuth } from "../auth/manager.ts";
import { refreshTokens, resolveOAuthConfig, revokeTokens } from "../auth/oauth.ts";
import type { StoredTokens } from "../auth/store.ts";
import { type GenerateOptions, OaiImage } from "../client.ts";
import { REFRESH_INTERVAL_MS, REFRESH_WINDOW_MS } from "../constants.ts";
import { ApiError, AuthRequiredError, LoginError, OaiImageError, UsageLimitError, ValidationError } from "../errors.ts";
import { randomToken, type Sealed, seal, unseal } from "./crypto.ts";
import type { Env } from "./env.ts";

/**
 * A vault holds one ChatGPT sign-in and the image jobs run with it.
 *
 * There is one vault per OAuth grant, addressed by a random id. The ChatGPT
 * tokens are stored encrypted with a key that is not kept here: it lives only
 * in the grant's props, which the OAuth provider in turn encrypts with a key
 * wrapped by the grant's own access and refresh tokens. Reading this object's
 * storage, or the OAuth KV namespace, is therefore not enough to use anyone's
 * ChatGPT login; a caller needs a live token for that grant.
 *
 * Running jobs inside the object gives two things the stateless Worker lacks:
 * a single place to serialize refreshes (ChatGPT refresh tokens are
 * single-use) and somewhere for long renders to keep running after the
 * request that started them has returned.
 */

export type JobStatus = "working" | "completed" | "cancelled";

export interface StoredImage {
	key: string;
	mimeType: string;
	extension: string;
	width?: number;
	height?: number;
	bytes: number;
}

export interface JobOutcome {
	isError: boolean;
	/** Error text for a failed render. */
	message?: string;
	/** Machine-readable reason for a failed render, e.g. `auth_required`, `usage_limit`. */
	code?: string;
	resetsAt?: string;
	operation: "generate" | "edit";
	model?: string;
	warnings: string[];
	images: StoredImage[];
}

export interface Job {
	id: string;
	status: JobStatus;
	statusMessage?: string;
	operation: "generate" | "edit";
	createdAt: string;
	lastUpdatedAt: string;
	/** How long the job and its images are kept, from creation. */
	ttlMs: number;
	outcome?: JobOutcome;
}

/** What a tool call asks for. Images are data: or https: URLs only. */
export type JobRequest = Omit<GenerateOptions, "signal" | "images" | "timeoutMs" | "extraBody"> & { images?: string[] };

export type VaultResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

interface VaultMeta {
	vaultId: string;
	createdAt: string;
	lastUsedAt: string;
	email?: string;
	planType?: string;
}

export const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** A vault nobody has used for this long is wiped (its grant's refresh token is dead by then too). */
export const VAULT_IDLE_MS = 35 * 24 * 60 * 60 * 1000;
/** Renders running at once per sign-in. */
export const MAX_RUNNING_JOBS = 3;
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export class Vault extends DurableObject<Env> {
	/** Renders in flight in this instance. An instance restart loses them; see {@link #bootedAt}. */
	readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
	/** Jobs created before this instance started cannot still be running. */
	readonly #bootedAt = Date.now();
	#refreshing: Promise<StoredTokens> | undefined;

	/** Store a fresh sign-in. Called once, when the grant is created. */
	async saveLogin(vaultId: string, key: string, tokens: StoredTokens): Promise<void> {
		const identity = readIdentity(tokens.accessToken, tokens.idToken);
		const now = new Date().toISOString();
		const meta: VaultMeta = {
			vaultId,
			createdAt: now,
			lastUsedAt: now,
			email: identity.email,
			planType: identity.planType,
		};
		await this.ctx.storage.put({ meta, creds: await seal(key, JSON.stringify(tokens), credsContext(vaultId)) });
		await this.#scheduleAlarm();
	}

	/** Who is signed in. Needs the key, so it also proves the caller holds the grant. */
	async status(key: string): Promise<VaultResult<{ email?: string; planType?: string; accountId?: string }>> {
		return this.#guard(async () => {
			const tokens = await this.#loadTokens(key);
			const identity = readIdentity(tokens.accessToken, tokens.idToken);
			return { email: identity.email, planType: identity.planType, accountId: identity.accountId };
		});
	}

	/** Forget the sign-in, revoke it at OpenAI, and delete every job and image. */
	async signOut(key: string): Promise<VaultResult<{ revoked: boolean }>> {
		return this.#guard(async () => {
			const tokens = await this.#loadTokens(key);
			for (const { controller } of this.#running.values()) controller.abort();
			const revoked = await revokeTokens(this.#oauthConfig(), tokens);
			await this.#deleteEverything();
			return { revoked };
		});
	}

	/**
	 * Create a job and start rendering. Returns once the job is stored, so a
	 * `tasks/get` for its id resolves immediately.
	 */
	async startJob(key: string, request: JobRequest): Promise<VaultResult<Job>> {
		return this.#guard(async () => {
			// Fail now, not in the background, if the login is gone.
			await this.#resolveAuth(key);
			if (this.#running.size >= MAX_RUNNING_JOBS) {
				throw new OaiImageError(
					`${MAX_RUNNING_JOBS} images are already rendering for this account. Wait for one to finish.`,
				);
			}
			const now = new Date().toISOString();
			const job: Job = {
				id: randomToken(24),
				status: "working",
				statusMessage: "Rendering. This usually takes 20 seconds to 2 minutes.",
				operation: request.images && request.images.length > 0 ? "edit" : "generate",
				createdAt: now,
				lastUpdatedAt: now,
				ttlMs: JOB_TTL_MS,
			};
			const controller = new AbortController();
			let finished!: () => void;
			const done = new Promise<void>(resolve => {
				finished = resolve;
			});
			// Registered before the first await so the alarm never mistakes it for an orphan.
			this.#running.set(job.id, { controller, done });
			try {
				await this.ctx.storage.put(jobKey(job.id), job);
			} catch (error) {
				this.#running.delete(job.id);
				finished();
				throw error;
			}
			this.#render(job, key, request, controller.signal).finally(() => {
				this.#running.delete(job.id);
				finished();
			});
			// The alarm handler waits for running renders, which keeps this object
			// alive after the request that started the job has returned.
			await this.ctx.storage.setAlarm(Date.now());
			return job;
		});
	}

	async getJob(id: string): Promise<Job | null> {
		const job = await this.ctx.storage.get<Job>(jobKey(id));
		if (!job) return null;
		if (job.status === "working" && this.#isOrphan(job)) return this.#markOrphan(job);
		if (Date.parse(job.createdAt) + job.ttlMs < Date.now()) return null;
		return job;
	}

	/** Ask a job to stop. Returns false when there is no such job. */
	async cancelJob(id: string): Promise<boolean> {
		const job = await this.ctx.storage.get<Job>(jobKey(id));
		if (!job) return false;
		if (job.status !== "working") return true;
		this.#running.get(id)?.controller.abort();
		await this.#update(id, { status: "cancelled", statusMessage: "Cancelled." });
		return true;
	}

	/**
	 * Keeps the object alive while renders run, then housekeeping: orphaned
	 * jobs, expired jobs and images, and vaults nobody uses any more.
	 */
	override async alarm(): Promise<void> {
		while (this.#running.size > 0) {
			await Promise.allSettled([...this.#running.values()].map(entry => entry.done));
		}
		const now = Date.now();
		const meta = await this.ctx.storage.get<VaultMeta>("meta");
		if (!meta || Date.parse(meta.lastUsedAt) + VAULT_IDLE_MS < now) {
			await this.#deleteEverything();
			return;
		}
		const jobs = await this.ctx.storage.list<Job>({ prefix: "job:" });
		for (const job of jobs.values()) {
			if (Date.parse(job.createdAt) + job.ttlMs < now) {
				await this.#deleteJob(job);
			} else if (job.status === "working" && this.#isOrphan(job)) {
				await this.#markOrphan(job);
			}
		}
		await this.#scheduleAlarm();
	}

	async #render(job: Job, key: string, request: JobRequest, signal: AbortSignal): Promise<void> {
		const client = new OaiImage({
			auth: { getAuth: options => this.#resolveAuth(key, options?.rejectedAccessToken) },
			...(this.env.OAI_IMAGE_BASE_URL ? { baseUrl: this.env.OAI_IMAGE_BASE_URL } : {}),
		});
		let outcome: JobOutcome;
		try {
			const result = await client.generate({ ...request, signal, timeoutMs: RENDER_TIMEOUT_MS });
			const images: StoredImage[] = [];
			for (const [index, image] of result.images.entries()) {
				const objectKey = `img/${job.id}/${index + 1}.${image.extension}`;
				await this.env.IMAGES.put(objectKey, image.bytes, {
					httpMetadata: { contentType: image.mimeType },
				});
				images.push({
					key: objectKey,
					mimeType: image.mimeType,
					extension: image.extension,
					width: image.width,
					height: image.height,
					bytes: image.byteLength,
				});
			}
			outcome = {
				isError: false,
				operation: result.operation,
				model: result.model,
				warnings: result.warnings,
				images,
			};
		} catch (error) {
			if (signal.aborted) return;
			outcome = {
				isError: true,
				message: error instanceof Error ? error.message : String(error),
				code: errorCode(error),
				resetsAt: error instanceof UsageLimitError ? error.resetsAt?.toISOString() : undefined,
				operation: job.operation,
				warnings: [],
				images: [],
			};
		}
		const current = await this.ctx.storage.get<Job>(jobKey(job.id));
		if (!current || current.status !== "working") {
			// Cancelled while the render finished; drop what it made.
			for (const image of outcome.images) await this.env.IMAGES.delete(image.key);
			return;
		}
		await this.#update(job.id, {
			status: "completed",
			statusMessage: outcome.isError ? "Failed." : `Done: ${outcome.images.length} image(s).`,
			outcome,
		});
	}

	async #resolveAuth(key: string, rejectedAccessToken?: string): Promise<ResolvedAuth> {
		let tokens = await this.#loadTokens(key);
		const rejected = rejectedAccessToken !== undefined && rejectedAccessToken === tokens.accessToken;
		if (rejected || needsRefresh(tokens)) tokens = await this.#refresh(key, tokens, rejected);
		await this.#touch();
		const identity = readIdentity(tokens.accessToken, tokens.idToken);
		return { accessToken: tokens.accessToken, accountId: identity.accountId ?? tokens.accountId, identity };
	}

	/** One refresh at a time: the refresh token is single-use, and losing the replacement loses the login. */
	#refresh(key: string, observed: StoredTokens, rejected: boolean): Promise<StoredTokens> {
		this.#refreshing ??= (async () => {
			const latest = await this.#loadTokens(key);
			if (latest.accessToken !== observed.accessToken && !needsRefresh(latest)) return latest;
			if (!rejected && !needsRefresh(latest)) return latest;
			const meta = await this.#meta();
			try {
				const next = await refreshTokens(this.#oauthConfig(), latest);
				await this.ctx.storage.put("creds", await seal(key, JSON.stringify(next), credsContext(meta.vaultId)));
				return next;
			} catch (error) {
				// A refresh token that can never work again: forget the login so
				// the grant gets revoked and the client signs in afresh.
				if (error instanceof AuthRequiredError) await this.ctx.storage.delete("creds");
				throw error;
			}
		})().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #loadTokens(key: string): Promise<StoredTokens> {
		const [meta, creds] = await Promise.all([
			this.ctx.storage.get<VaultMeta>("meta"),
			this.ctx.storage.get<Sealed>("creds"),
		]);
		if (!meta || !creds) throw new AuthRequiredError("This sign-in has ended. Reconnect to sign in with ChatGPT again.");
		let plaintext: string;
		try {
			plaintext = await unseal(key, creds, credsContext(meta.vaultId));
		} catch {
			throw new AuthRequiredError("This sign-in could not be unlocked. Reconnect to sign in with ChatGPT again.");
		}
		return JSON.parse(plaintext) as StoredTokens;
	}

	async #meta(): Promise<VaultMeta> {
		const meta = await this.ctx.storage.get<VaultMeta>("meta");
		if (!meta) throw new AuthRequiredError("This sign-in has ended. Reconnect to sign in with ChatGPT again.");
		return meta;
	}

	async #touch(): Promise<void> {
		const meta = await this.#meta();
		if (Date.parse(meta.lastUsedAt) + TOUCH_INTERVAL_MS > Date.now()) return;
		await this.ctx.storage.put("meta", { ...meta, lastUsedAt: new Date().toISOString() });
	}

	#oauthConfig() {
		return resolveOAuthConfig(this.env.OAI_IMAGE_ISSUER ? { issuer: this.env.OAI_IMAGE_ISSUER } : {});
	}

	#isOrphan(job: Job): boolean {
		return !this.#running.has(job.id) && Date.parse(job.createdAt) < this.#bootedAt;
	}

	async #markOrphan(job: Job): Promise<Job> {
		return this.#update(job.id, {
			status: "completed",
			statusMessage: "Interrupted.",
			outcome: {
				isError: true,
				code: "interrupted",
				message: "The server restarted while this image was rendering. Try again.",
				operation: job.operation,
				warnings: [],
				images: [],
			},
		});
	}

	async #update(id: string, patch: Partial<Job>): Promise<Job> {
		const job = await this.ctx.storage.get<Job>(jobKey(id));
		if (!job) throw new OaiImageError("Job not found");
		const next: Job = { ...job, ...patch, lastUpdatedAt: new Date().toISOString() };
		await this.ctx.storage.put(jobKey(id), next);
		return next;
	}

	async #deleteJob(job: Job): Promise<void> {
		const keys = job.outcome?.images.map(image => image.key) ?? [];
		if (keys.length > 0) await this.env.IMAGES.delete(keys);
		await this.ctx.storage.delete(jobKey(job.id));
	}

	async #deleteEverything(): Promise<void> {
		const jobs = await this.ctx.storage.list<Job>({ prefix: "job:" });
		const keys = [...jobs.values()].flatMap(job => job.outcome?.images.map(image => image.key) ?? []);
		for (let i = 0; i < keys.length; i += 1000) await this.env.IMAGES.delete(keys.slice(i, i + 1000));
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	/** Next housekeeping: the earliest job expiry, or the idle deadline. */
	async #scheduleAlarm(): Promise<void> {
		const meta = await this.ctx.storage.get<VaultMeta>("meta");
		if (!meta) return;
		let next = Date.parse(meta.lastUsedAt) + VAULT_IDLE_MS;
		const jobs = await this.ctx.storage.list<Job>({ prefix: "job:" });
		for (const job of jobs.values()) next = Math.min(next, Date.parse(job.createdAt) + job.ttlMs + 1000);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next || this.#running.size === 0) await this.ctx.storage.setAlarm(next);
	}

	/** Errors cross the RPC boundary as plain values so their kind survives. */
	async #guard<T>(task: () => Promise<T>): Promise<VaultResult<T>> {
		try {
			return { ok: true, value: await task() };
		} catch (error) {
			return { ok: false, code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
		}
	}
}

function jobKey(id: string): string {
	return `job:${id}`;
}

function credsContext(vaultId: string): string {
	return `oai-image/vault/${vaultId}/creds`;
}

function needsRefresh(tokens: StoredTokens): boolean {
	const expiresAt = jwtExpiresAt(tokens.accessToken);
	if (expiresAt !== undefined) return expiresAt <= Date.now() + REFRESH_WINDOW_MS;
	if (!tokens.lastRefresh) return false;
	const last = Date.parse(tokens.lastRefresh);
	return Number.isFinite(last) && last < Date.now() - REFRESH_INTERVAL_MS;
}

export function errorCode(error: unknown): string {
	if (error instanceof AuthRequiredError) return "auth_required";
	if (error instanceof UsageLimitError) return "usage_limit";
	if (error instanceof ValidationError) return "invalid_request";
	if (error instanceof LoginError) return "login_failed";
	if (error instanceof ApiError) return "upstream_error";
	if (error instanceof OaiImageError) return "error";
	return "internal";
}
