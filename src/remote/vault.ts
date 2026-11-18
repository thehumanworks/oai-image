import { DurableObject } from "cloudflare:workers";
import { readIdentity } from "../auth/jwt.ts";
import type { ResolvedAuth } from "../auth/manager.ts";
import { refreshTokens, resolveOAuthConfig, revokeTokens } from "../auth/oauth.ts";
import type { StoredTokens } from "../auth/store.ts";
import { type GenerateOptions, type ImageWarning, OaiImage, type SizingReport } from "../client.ts";
import { AuthRequiredError, type ErrorReport, errorCode, errorReport, OaiImageError, UsageLimitError } from "../errors.ts";
import { hmacSha256, randomToken, type Sealed, seal, unseal } from "./crypto.ts";
import type { Env } from "./env.ts";
import { backgroundRefreshAt, MIN_BACKGROUND_GAP_MS, needsRefresh, retryDelay } from "./schedule.ts";

/**
 * A vault holds one ChatGPT sign-in and the image jobs run with it.
 *
 * There is one vault per OAuth grant, addressed by a random id. The ChatGPT
 * tokens are stored encrypted with a key that lives in the grant's props,
 * which the OAuth provider in turn encrypts with a key wrapped by the grant's
 * own access and refresh tokens. A caller needs a live token for that grant to
 * use the sign-in.
 *
 * The vault also keeps the sign-in alive by itself: its alarm refreshes the
 * ChatGPT tokens on a schedule (see schedule.ts), whether or not the client
 * is connected. For that it holds a second copy of the key, the "escrow",
 * encrypted with a key derived from a Worker secret. Reading this object's
 * storage, or the OAuth KV namespace, is still not enough to use anyone's
 * ChatGPT login; that takes a live token for the grant, or the storage and
 * the Worker secret together. Without the secret there is no escrow, and
 * tokens are refreshed only when the client calls.
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
	/** Everything known about a failure: code, retryable, request ids. */
	report?: ErrorReport;
	operation: "generate" | "edit";
	model?: string;
	/** Plain strings in jobs stored before warnings had codes. */
	warnings: (ImageWarning | string)[];
	sizing?: SizingReport;
	requestId?: string;
	imagegenRequestId?: string;
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

/** The background refresh schedule. Holds no secrets. */
interface RefreshState {
	/** When the alarm should next refresh the ChatGPT tokens, in epoch milliseconds. */
	dueAt: number;
	/** Background refreshes that have failed in a row for a passing reason. */
	failures: number;
}

/** Why a refresh was asked for: the tokens are due, the backend rejected them, or the alarm's schedule says so. */
type RefreshReason = "due" | "rejected" | "background";

export const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** A vault nobody has used for this long is wiped (its grant's refresh token is dead by then too). */
export const VAULT_IDLE_MS = 400 * 24 * 60 * 60 * 1000;
/**
 * Renders sent to ChatGPT at once per sign-in. Codex never runs image calls
 * in parallel, and parallel calls from one account coincided with ChatGPT's
 * edge answering with block pages; further jobs wait their turn.
 */
export const MAX_CONCURRENT_RENDERS = 1;
/** Jobs that may wait behind the running ones before new ones are refused. */
export const MAX_QUEUED_JOBS = 4;
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export class Vault extends DurableObject<Env> {
	/** Renders in flight in this instance. An instance restart loses them; see {@link #bootedAt}. */
	readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
	/** Jobs created before this instance started cannot still be running. */
	readonly #bootedAt = Date.now();
	/** Render slots, handed out first come, first served. */
	readonly #slots = new Slots(MAX_CONCURRENT_RENDERS);
	#refreshing: Promise<StoredTokens> | undefined;
	#escrowKey: Promise<string | undefined> | undefined;

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
		await this.ctx.storage.put({ meta, ...(await this.#sealTokens(key, vaultId, tokens)) });
		await this.#escrow(key, vaultId);
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

	/**
	 * Refresh the ChatGPT sign-in if it is due, and mark the vault as in use.
	 * Called whenever the MCP client refreshes its own token, so a connected
	 * client keeps the ChatGPT login alive even when no images are made.
	 */
	async keepAlive(key: string): Promise<VaultResult<null>> {
		return this.#guard(async () => {
			await this.#resolveAuth(key);
			return null;
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
			if (this.#running.size >= MAX_CONCURRENT_RENDERS + MAX_QUEUED_JOBS) {
				throw new OaiImageError(
					`${this.#running.size} images are already rendering or waiting for this account. Wait for one to finish.`,
				);
			}
			const ahead = this.#slots.waitingFor();
			const now = new Date().toISOString();
			const job: Job = {
				id: randomToken(24),
				status: "working",
				statusMessage:
					ahead > 0
						? `Queued behind ${ahead} other image${ahead === 1 ? "" : "s"} for this account; images render one at a time.`
						: RENDERING_MESSAGE,
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
	 * jobs, expired jobs and images, vaults nobody uses any more, and the
	 * background refresh of the ChatGPT sign-in.
	 */
	override async alarm(): Promise<void> {
		while (this.#running.size > 0) {
			await Promise.allSettled([...this.#running.values()].map(entry => entry.done));
		}
		const now = Date.now();
		const meta = await this.ctx.storage.get<VaultMeta>("meta");
		if (!meta || Date.parse(meta.lastUsedAt) + VAULT_IDLE_MS < now) {
			if (meta) await this.#revokeAbandonedLogin(meta);
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
		// A failed refresh must not make the runtime retry the whole alarm.
		await this.#backgroundRefresh(meta).catch(error => {
			log("warn", "background refresh crashed", { message: error instanceof Error ? error.message : String(error) });
		});
		await this.#scheduleAlarm();
	}

	/**
	 * Refresh the ChatGPT tokens when the schedule says so, with no client
	 * involved. A failure that may pass is retried with a growing delay. A
	 * sign-in OpenAI has ended for good is forgotten, and the client is sent
	 * through sign-in again on its next call.
	 */
	async #backgroundRefresh(meta: VaultMeta): Promise<void> {
		const state = await this.ctx.storage.get<RefreshState>("refresh");
		if (!state || state.dueAt > Date.now()) return;
		const key = await this.#escrowedKey(meta);
		if (!key) {
			// No Worker secret, or it changed. The next call from the client stores the key again.
			await this.ctx.storage.delete("escrow");
			return;
		}
		try {
			const tokens = await this.#refresh(key, await this.#loadTokens(key), "background");
			// Also covers a refresh that a concurrent call had already made.
			const dueAt = Math.max(backgroundRefreshAt(tokens), Date.now() + MIN_BACKGROUND_GAP_MS);
			await this.ctx.storage.put("refresh", { dueAt, failures: 0 } satisfies RefreshState);
			log("info", "background refresh", { next: new Date(dueAt).toISOString() });
		} catch (error) {
			if (error instanceof AuthRequiredError) {
				await this.ctx.storage.delete(["escrow", "refresh"]);
				log("warn", "background refresh: sign-in ended", { reason: error.reason });
				return;
			}
			const failures = state.failures + 1;
			const dueAt = Date.now() + retryDelay(failures);
			await this.ctx.storage.put("refresh", { dueAt, failures } satisfies RefreshState);
			log("warn", "background refresh failed", {
				failures,
				retry: new Date(dueAt).toISOString(),
				error: errorCode(error),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Before an unused vault is wiped, end its sign-in at OpenAI too. Best effort. */
	async #revokeAbandonedLogin(meta: VaultMeta): Promise<void> {
		try {
			const key = await this.#escrowedKey(meta);
			if (key) await revokeTokens(this.#oauthConfig(), await this.#loadTokens(key));
		} catch {
			// Nothing usable is stored; there is nothing to revoke.
		}
	}

	async #render(job: Job, key: string, request: JobRequest, signal: AbortSignal): Promise<void> {
		const queued = this.#slots.waitingFor() > 0;
		const release = await this.#slots.acquire(signal);
		if (!release) return;
		try {
			if (queued) {
				const current = await this.ctx.storage.get<Job>(jobKey(job.id));
				if (!current || current.status !== "working") return;
				await this.#update(job.id, { statusMessage: RENDERING_MESSAGE });
			}
			await this.#renderNow(job, key, request, signal);
		} finally {
			release();
		}
	}

	async #renderNow(job: Job, key: string, request: JobRequest, signal: AbortSignal): Promise<void> {
		const client = new OaiImage({
			auth: { getAuth: options => this.#resolveAuth(key, options?.rejectedAccessToken) },
			...(this.env.OAI_IMAGE_BASE_URL ? { baseUrl: this.env.OAI_IMAGE_BASE_URL } : {}),
		});
		const startedAt = Date.now();
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
				sizing: result.sizing,
				requestId: result.requestId,
				imagegenRequestId: result.imagegenRequestId,
				images,
			};
			log("info", "render finished", {
				job: job.id,
				operation: result.operation,
				ms: Date.now() - startedAt,
				sent_size: result.sizing.sent.size,
				actual: result.sizing.actual ? `${result.sizing.actual.width}x${result.sizing.actual.height}` : undefined,
				warnings: result.warnings.map(warning => warning.code),
				request_id: result.requestId,
				queued: this.#slots.queued,
			});
		} catch (error) {
			if (signal.aborted) return;
			const report = errorReport(error);
			outcome = {
				isError: true,
				message: report.message,
				code: report.error,
				resetsAt: error instanceof UsageLimitError ? error.resetsAt?.toISOString() : undefined,
				report,
				operation: job.operation,
				warnings: [],
				images: [],
			};
			// Enough to tell a size problem from an edge block or a rate limit after the fact. No prompt, no tokens.
			log("warn", "render failed", {
				job: job.id,
				operation: job.operation,
				ms: Date.now() - startedAt,
				error: report.error,
				status: report.status,
				retryable: report.retryable,
				request_id: report.request_id,
				cf_ray: report.cf_ray,
				cf_mitigated: (error as { cfMitigated?: string }).cfMitigated,
				size: request.size,
				aspect_ratio: request.aspectRatio,
				queued: this.#slots.queued,
			});
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
		if (rejected || needsRefresh(tokens)) tokens = await this.#refresh(key, tokens, rejected ? "rejected" : "due");
		await this.#enrol(key, tokens);
		await this.#touch();
		const identity = readIdentity(tokens.accessToken, tokens.idToken);
		return { accessToken: tokens.accessToken, accountId: identity.accountId ?? tokens.accountId, identity };
	}

	/** One refresh at a time: the refresh token is single-use, and losing the replacement loses the login. */
	#refresh(key: string, observed: StoredTokens, reason: RefreshReason): Promise<StoredTokens> {
		this.#refreshing ??= (async () => {
			const latest = await this.#loadTokens(key);
			if (latest.accessToken !== observed.accessToken && !needsRefresh(latest)) return latest;
			if (reason === "due" && !needsRefresh(latest)) return latest;
			const meta = await this.#meta();
			try {
				const next = await refreshTokens(this.#oauthConfig(), latest);
				await this.ctx.storage.put(await this.#sealTokens(key, meta.vaultId, next));
				return next;
			} catch (error) {
				// A refresh token that can never work again: forget the login so
				// the grant gets revoked and the client signs in afresh.
				if (error instanceof AuthRequiredError) await this.ctx.storage.delete(["creds", "escrow", "refresh"]);
				throw error;
			}
		})().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	/** The storage entries for a set of tokens: the tokens, encrypted, and when to refresh them next. */
	async #sealTokens(key: string, vaultId: string, tokens: StoredTokens): Promise<{ creds: Sealed; refresh: RefreshState }> {
		return {
			creds: await seal(key, JSON.stringify(tokens), credsContext(vaultId)),
			refresh: { dueAt: backgroundRefreshAt(tokens), failures: 0 },
		};
	}

	/**
	 * Keep a copy of the vault key that the server can open by itself, so the
	 * alarm can refresh the tokens. Does nothing without the Worker secret.
	 */
	async #escrow(key: string, vaultId: string): Promise<boolean> {
		const escrowKey = await this.#serverKey();
		if (!escrowKey) return false;
		await this.ctx.storage.put("escrow", await seal(escrowKey, key, escrowContext(vaultId)));
		return true;
	}

	/**
	 * Set up the background refresh for a vault that has none: one made before
	 * background refresh existed, or one whose escrow could no longer be opened.
	 * `key` has just decrypted the tokens, so it is the right one to keep.
	 */
	async #enrol(key: string, tokens: StoredTokens): Promise<void> {
		if (await this.ctx.storage.get<Sealed>("escrow")) return;
		const meta = await this.#meta();
		if (!(await this.#escrow(key, meta.vaultId))) return;
		if (!(await this.ctx.storage.get<RefreshState>("refresh"))) {
			await this.ctx.storage.put("refresh", { dueAt: backgroundRefreshAt(tokens), failures: 0 } satisfies RefreshState);
		}
		await this.#scheduleAlarm();
	}

	/** The vault key from the escrow. Undefined when there is no escrow or the Worker secret cannot open it. */
	async #escrowedKey(meta: VaultMeta): Promise<string | undefined> {
		const [escrow, escrowKey] = await Promise.all([this.ctx.storage.get<Sealed>("escrow"), this.#serverKey()]);
		if (!escrow || !escrowKey) return undefined;
		try {
			return await unseal(escrowKey, escrow, escrowContext(meta.vaultId));
		} catch {
			return undefined;
		}
	}

	/** The key that seals escrows, derived from the Worker secret so that secret is never used directly. */
	#serverKey(): Promise<string | undefined> {
		const secret = this.env.IMAGE_URL_SECRET;
		// The same minimum as for signing image links (images.ts).
		this.#escrowKey ??= secret && secret.length >= 32 ? hmacSha256(secret, ESCROW_KEY_LABEL) : Promise.resolve(undefined);
		return this.#escrowKey;
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

	/** Next alarm: the earliest job expiry, the next background refresh, or the idle deadline. */
	async #scheduleAlarm(): Promise<void> {
		const meta = await this.ctx.storage.get<VaultMeta>("meta");
		if (!meta) return;
		let next = Date.parse(meta.lastUsedAt) + VAULT_IDLE_MS;
		const jobs = await this.ctx.storage.list<Job>({ prefix: "job:" });
		for (const job of jobs.values()) next = Math.min(next, Date.parse(job.createdAt) + job.ttlMs + 1000);
		const [refresh, escrow] = await Promise.all([
			this.ctx.storage.get<RefreshState>("refresh"),
			this.ctx.storage.get<Sealed>("escrow"),
		]);
		if (refresh && escrow) next = Math.min(next, refresh.dueAt);
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

function escrowContext(vaultId: string): string {
	return `oai-image/vault/${vaultId}/escrow`;
}

/** Domain separation for the escrow key, so it differs from every other use of the Worker secret. */
const ESCROW_KEY_LABEL = "oai-image/vault-escrow/v1";

const RENDERING_MESSAGE = "Rendering. This usually takes 20 seconds to 2 minutes.";

function log(level: "info" | "warn", message: string, fields: Record<string, unknown>): void {
	console[level](JSON.stringify({ message, ...fields }));
}

/** A first-come, first-served counting semaphore. */
class Slots {
	readonly #size: number;
	#free: number;
	readonly #waiting: Array<() => void> = [];

	constructor(size: number) {
		this.#size = size;
		this.#free = size;
	}

	/** How many jobs a new caller would wait behind: 0 when a slot is free. */
	waitingFor(): number {
		return this.#free > 0 ? 0 : this.#size + this.#waiting.length;
	}

	/** How many callers are waiting. */
	get queued(): number {
		return this.#waiting.length;
	}

	/** Wait for a slot. Resolves to its release function, or undefined when `signal` aborts first. */
	acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
		if (signal.aborted) return Promise.resolve(undefined);
		if (this.#free > 0) {
			this.#free--;
			return Promise.resolve(this.#releaser());
		}
		return new Promise(resolve => {
			const grant = () => {
				signal.removeEventListener("abort", abandon);
				resolve(this.#releaser());
			};
			const abandon = () => {
				const index = this.#waiting.indexOf(grant);
				if (index >= 0) this.#waiting.splice(index, 1);
				resolve(undefined);
			};
			this.#waiting.push(grant);
			signal.addEventListener("abort", abandon, { once: true });
		});
	}

	#releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiting.shift();
			if (next) next();
			else this.#free++;
		};
	}
}
