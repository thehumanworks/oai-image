import { randomUUID } from "node:crypto";
import { type AuthProvider, defaultAuth, type ResolvedAuth } from "./auth/manager.ts";
import { describe, type FetchLike } from "./auth/oauth.ts";
import {
	CODEX_COMPAT_VERSION,
	DEFAULT_BASE_URL,
	DEFAULT_ORIGINATOR,
	DEFAULT_REQUEST_TIMEOUT_MS,
	ENV,
	MAX_INPUT_IMAGES,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	resolveModel,
} from "./constants.ts";
import {
	ApiError,
	type ApiErrorDetails,
	AuthRequiredError,
	OaiImageError,
	ResponseError,
	UsageLimitError,
	ValidationError,
} from "./errors.ts";
import { type ImageInput, type ImageReference, toImageReference } from "./input.ts";
import { GeneratedImage } from "./output.ts";
import { resolveSize, sizeHint } from "./size.ts";

export interface OaiImageOptions {
	/** Credential source. Default: the saved `oai-image login`. */
	auth?: AuthProvider;
	/** Default model for every call; see {@link GenerateOptions.model}. */
	model?: string;
	/** Default `https://chatgpt.com/backend-api/codex`. */
	baseUrl?: string;
	/** Value of the `originator` header. */
	originator?: string;
	userAgent?: string;
	fetch?: FetchLike;
	/**
	 * Per-request timeout. Default 10 minutes. Under Node.js the built-in fetch
	 * gives up after 5 minutes without a response regardless; pass your own
	 * `fetch` to wait longer.
	 */
	timeoutMs?: number;
	/**
	 * Extra attempts after a network failure or a 502/503/504. Default 0: a
	 * failed call may still have used plan quota, so nothing is retried unasked.
	 */
	maxRetries?: number;
}

export type ImageQuality = "auto" | "low" | "medium" | "high" | (string & {});
export type ImageBackground = "auto" | "opaque" | "transparent";

export interface GifOptions {
	/** Number of frames, 2–16. Backend default: 9. */
	frameCount?: number;
	/** Duration of each frame in milliseconds, 20–2000. Backend default: 200. */
	frameDurationMs?: number;
}

export interface GenerateOptions {
	prompt: string;
	/**
	 * Image model id or alias (`gpt-image-2.6`, `sunburst`, `flare`, `latest`).
	 * Sent verbatim after alias resolution. Default: `OAI_IMAGE_MODEL`, then
	 * `gpt-image-2.6-sunburst`.
	 */
	model?: string;
	/** `auto`, `WIDTHxHEIGHT`, or `square` / `landscape` / `portrait` / `2k` / `4k`. */
	size?: string;
	/** Alternative to `size`, e.g. `16:9`. */
	aspectRatio?: string;
	quality?: ImageQuality;
	/** Default `opaque`, which is what Codex sends unless transparency is asked for. */
	background?: ImageBackground;
	/** Number of images. */
	n?: number;
	/** Images to edit or use as references. Giving any turns the call into an edit. */
	images?: readonly ImageInput[];
	/** Ask for an animated GIF. */
	gif?: boolean | GifOptions;
	/**
	 * When a size or aspect ratio is requested, also state it in the prompt
	 * (default true). OpenAI's Codex guide says to describe framing and
	 * dimensions in the prompt, and the backend is reported to disregard the
	 * `size` field.
	 */
	sizeHint?: boolean;
	/** Extra top-level request fields, merged last (for example `{ moderation: "low" }`). */
	extraBody?: Readonly<Record<string, unknown>>;
	signal?: AbortSignal;
	/** Overrides {@link OaiImageOptions.timeoutMs} for this call. */
	timeoutMs?: number;
}

export interface EditOptions extends GenerateOptions {
	images: readonly ImageInput[];
}

export interface ImageResult {
	images: GeneratedImage[];
	operation: "generate" | "edit";
	/**
	 * Model id sent in the request. The backend does not echo the model it
	 * ran, and on a ChatGPT login it may substitute its own.
	 */
	model: string;
	/** Model the backend reports having run, in the rare case it says. */
	reportedModel?: string;
	/** Prompt as sent, including any size hint. */
	prompt: string;
	/** `size` as reported by the backend. */
	size?: string;
	quality?: string;
	background?: string;
	outputFormat?: string;
	/** Unix seconds. */
	created?: number;
	usage?: Record<string, unknown>;
	requestId?: string;
	imagegenRequestId?: string;
	/** Things that did not go as asked, e.g. a different canvas than requested. */
	warnings: string[];
	/** Response body without the image data, for fields this package does not model. */
	raw: Record<string, unknown>;
	/** Diagnostic response headers (`x-codex-*`, request ids). */
	responseHeaders: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Image generation and editing through a ChatGPT subscription. */
export class OaiImage {
	readonly auth: AuthProvider;
	readonly baseUrl: string;
	readonly #options: OaiImageOptions;
	readonly #fetch: FetchLike;

	constructor(options: OaiImageOptions = {}) {
		this.#options = options;
		this.auth = options.auth ?? defaultAuth({ fetch: options.fetch });
		this.baseUrl = (options.baseUrl ?? process.env[ENV.baseUrl] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
	}

	/** Generate images from a prompt. With `images`, this edits them instead. */
	async generate(options: GenerateOptions | string): Promise<ImageResult> {
		const request = typeof options === "string" ? { prompt: options } : options;
		const prompt = request.prompt?.trim();
		if (!prompt) throw new ValidationError("A prompt is required");

		const inputs = request.images ?? [];
		if (inputs.length > MAX_INPUT_IMAGES) {
			throw new ValidationError(`At most ${MAX_INPUT_IMAGES} input images are accepted; got ${inputs.length}`);
		}
		if (request.n !== undefined && (!Number.isInteger(request.n) || request.n < 1 || request.n > 10)) {
			throw new ValidationError("n must be a whole number between 1 and 10");
		}
		if (request.background !== undefined && !["auto", "opaque", "transparent"].includes(request.background)) {
			throw new ValidationError('background must be "auto", "opaque" or "transparent"');
		}

		const model = resolveModel(request.model ?? this.#options.model);
		const size = resolveSize(request.size, request.aspectRatio);
		const hint = request.sizeHint === false ? undefined : sizeHint(size);
		const sentPrompt = hint ? `${prompt}\n\n${hint}` : prompt;
		const references: ImageReference[] = await Promise.all(inputs.map(toImageReference));
		const operation = references.length > 0 ? "edit" : "generate";

		// Field order follows Codex's request structs; GIF controls sit beside
		// `output_format`, not nested under it.
		const body: Record<string, unknown> = {
			...(references.length > 0 ? { images: references } : {}),
			prompt: sentPrompt,
			...gifFields(request.gif),
			// Codex always states the background and only ever sends these two
			// values on this route, so "opaque" is the default rather than "auto".
			background: request.background ?? "opaque",
			model,
			...(request.n !== undefined ? { n: request.n } : {}),
			quality: request.quality ?? "auto",
			size: size.size,
			...request.extraBody,
		};

		const { response, json } = await this.#post(
			operation === "edit" ? "images/edits" : "images/generations",
			body,
			request.signal,
			request.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		return buildResult({ json, response, operation, model, prompt: sentPrompt, request, size });
	}

	/** Edit images, or generate a new one using them as references. */
	async edit(options: EditOptions): Promise<ImageResult> {
		if (!options.images || options.images.length === 0) {
			throw new ValidationError("edit() needs at least one input image");
		}
		return this.generate(options);
	}

	async #post(
		path: string,
		body: Record<string, unknown>,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<{ response: Response; json: Record<string, unknown> }> {
		const url = `${this.baseUrl}/${path}`;
		const payload = JSON.stringify(body);
		const turnId = randomUUID();
		const maxRetries = Math.max(0, this.#options.maxRetries ?? 0);
		const deadline = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

		let auth = await this.auth.getAuth({ signal });
		let reauthenticated = false;
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method: "POST",
					headers: this.#headers(auth, turnId),
					body: payload,
					signal: combined,
				});
			} catch (cause) {
				if (signal?.aborted) throw new OaiImageError("The image request was cancelled", { cause });
				if (deadline.aborted) {
					throw new OaiImageError(`The image request timed out after ${Math.round(timeoutMs / 1000)}s`, { cause });
				}
				// Node's built-in fetch stops waiting for a response after 5 minutes,
				// whatever timeout was asked for. The request did reach the backend,
				// so it is not retried.
				if (isNodeHeadersTimeout(cause)) {
					throw new OaiImageError(
						"No response after 5 minutes, the longest Node.js's built-in fetch waits. " +
							"The request may still have counted against your usage. " +
							"The standalone binary waits for the full --timeout.",
						{ cause },
					);
				}
				if (attempt < maxRetries) {
					await backoff(attempt, combined);
					continue;
				}
				throw new OaiImageError(`Could not reach ${new URL(url).host}: ${describe(cause)}`, { cause });
			}

			if (response.ok) {
				const text = await response.text();
				let json: unknown;
				try {
					json = JSON.parse(text);
				} catch (cause) {
					throw new ResponseError(`The backend returned a response that is not JSON: ${text.slice(0, 200)}`, {
						cause,
					});
				}
				if (typeof json !== "object" || json === null || Array.isArray(json)) {
					throw new ResponseError("The backend returned an unexpected response shape");
				}
				return { response, json: json as Record<string, unknown> };
			}

			const text = await response.text().catch(() => "");
			// One refresh-and-retry on 401: the token may have been revoked or
			// rotated by another program since it was read.
			if (response.status === 401 && !reauthenticated) {
				reauthenticated = true;
				try {
					auth = await this.auth.getAuth({ rejectedAccessToken: auth.accessToken, signal });
				} catch (error) {
					// No way to get a better token: report why the backend refused this one.
					if (error instanceof AuthRequiredError) throw toApiError(response, text);
					throw error;
				}
				continue;
			}
			if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
				await backoff(attempt, combined);
				continue;
			}
			throw toApiError(response, text);
		}
	}

	#headers(auth: ResolvedAuth, turnId: string): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": this.#options.userAgent ?? defaultUserAgent(),
			originator: this.#options.originator ?? process.env[ENV.originator] ?? DEFAULT_ORIGINATOR,
			version: CODEX_COMPAT_VERSION,
			"x-codex-image-turn-id": turnId,
		};
		if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
		if (auth.identity.isFedramp) headers["X-OpenAI-Fedramp"] = "true";
		// Region-pinned workspaces reject requests that do not declare their residency.
		if (auth.identity.residency) headers["x-openai-internal-codex-residency"] = auth.identity.residency;
		return headers;
	}
}

function isNodeHeadersTimeout(error: unknown): boolean {
	const inner = error instanceof Error ? error.cause : undefined;
	return typeof inner === "object" && inner !== null && (inner as { code?: unknown }).code === "UND_ERR_HEADERS_TIMEOUT";
}

export function defaultUserAgent(): string {
	// The standalone binary runs on Bun, which also fills in a Node version for compatibility.
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`;
	return `${PACKAGE_NAME}/${PACKAGE_VERSION} (${process.platform}; ${process.arch}) ${runtime}`;
}

function gifFields(gif: GenerateOptions["gif"]): Record<string, unknown> {
	if (!gif) return {};
	const options = gif === true ? {} : gif;
	const { frameCount, frameDurationMs } = options;
	if (frameCount !== undefined && (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16)) {
		throw new ValidationError("gif.frameCount must be a whole number between 2 and 16");
	}
	if (frameDurationMs !== undefined && (!Number.isInteger(frameDurationMs) || frameDurationMs < 20 || frameDurationMs > 2000)) {
		throw new ValidationError("gif.frameDurationMs must be a whole number between 20 and 2000");
	}
	return {
		output_format: "gif",
		...(frameCount !== undefined ? { frame_count: frameCount } : {}),
		...(frameDurationMs !== undefined ? { frame_duration_ms: frameDurationMs } : {}),
	};
}

function buildResult(args: {
	json: Record<string, unknown>;
	response: Response;
	operation: "generate" | "edit";
	model: string;
	prompt: string;
	request: GenerateOptions;
	size: ReturnType<typeof resolveSize>;
}): ImageResult {
	const { json, response, request, size } = args;
	const { data, ...raw } = json;
	const requestId = response.headers.get("x-request-id") ?? undefined;
	const imagegenRequestId = response.headers.get("x-codex-imagegen-request-id") || undefined;
	if (!Array.isArray(data)) {
		const message = errorMessageFromBody(json);
		throw new ResponseError(
			message
				? `The backend returned no images: ${message}`
				: `The backend returned no image data${requestId ? ` (request ${requestId})` : ""}`,
		);
	}
	const images: GeneratedImage[] = [];
	for (const entry of data) {
		const item = entry as { b64_json?: unknown; generation_id?: unknown } | null;
		if (typeof item?.b64_json !== "string" || item.b64_json.length === 0) continue;
		images.push(
			new GeneratedImage(
				item.b64_json,
				images.length,
				typeof item.generation_id === "string" ? item.generation_id : undefined,
			),
		);
	}
	if (images.length === 0) {
		throw new ResponseError(`The backend returned no image data${requestId ? ` (request ${requestId})` : ""}`);
	}

	const warnings: string[] = [];
	const first = images[0] as GeneratedImage;
	if (size.width && size.height && first.width && first.height) {
		const actual = `${first.width}x${first.height}`;
		if (size.exact && (first.width !== size.width || first.height !== size.height)) {
			warnings.push(`Requested ${size.size} but the backend returned ${actual}.`);
		} else if (!size.exact && shapeOf(first.width, first.height) !== size.shape) {
			warnings.push(`Requested a ${size.shape} image but the backend returned ${actual}.`);
		}
	}
	const wanted = request.n ?? 1;
	if (images.length < wanted) {
		warnings.push(`Requested ${wanted} images but the backend returned ${images.length}.`);
	}
	if (request.background === "transparent" && raw.background === "opaque") {
		warnings.push("Requested a transparent background but the backend returned an opaque image.");
	}
	if (request.gif && first.mimeType !== "image/gif") {
		warnings.push(`Requested a GIF but the backend returned ${first.mimeType}.`);
	}

	return {
		images,
		operation: args.operation,
		model: args.model,
		reportedModel: typeof raw.model === "string" ? raw.model : undefined,
		prompt: args.prompt,
		size: typeof raw.size === "string" ? raw.size : undefined,
		quality: typeof raw.quality === "string" ? raw.quality : undefined,
		background: typeof raw.background === "string" ? raw.background : undefined,
		outputFormat: typeof raw.output_format === "string" ? raw.output_format : undefined,
		created: typeof raw.created === "number" ? raw.created : undefined,
		usage: isRecord(raw.usage) ? raw.usage : undefined,
		requestId,
		imagegenRequestId,
		warnings,
		raw,
		responseHeaders: diagnosticHeaders(response.headers),
	};
}

function toApiError(response: Response, text: string): OaiImageError {
	const status = response.status;
	const body = parseJson(text);
	const error = isRecord(body?.error) ? body.error : undefined;
	const detail = isRecord(body?.detail) ? body.detail : undefined;
	const code = str(error?.code) ?? str(detail?.code);
	const type = str(error?.type) ?? str(detail?.type);
	const details: ApiErrorDetails = {
		status,
		code,
		type,
		body: text.slice(0, 2000) || undefined,
		requestId: response.headers.get("x-request-id") ?? undefined,
		imagegenRequestId: response.headers.get("x-codex-imagegen-request-id") || undefined,
	};
	const message = (body && errorMessageFromBody(body)) ?? plainText(text);

	if (status === 401) {
		// Reached only when a refresh did not help or was not possible, so the login itself is the problem.
		return new AuthRequiredError(
			`ChatGPT rejected the login${message ? ` (${message})` : ""}. Run \`oai-image login\` to sign in again.`,
			"rejected",
			{ cause: new ApiError(`Image request failed (HTTP 401): ${message ?? "unauthorized"}`, details) },
		);
	}
	if (status === 429 && type === "usage_limit_reached") {
		const planType = str(error?.plan_type);
		const resetsAt = resetTime(error);
		const limitId = response.headers.get("x-codex-active-limit") ?? undefined;
		const parts = [`ChatGPT plan usage limit reached${planType ? ` (${planType} plan)` : ""}.`];
		if (resetsAt) parts.push(`It resets at ${resetsAt.toLocaleString()}.`);
		if (message) parts.push(message);
		return new UsageLimitError(parts.join(" "), { ...details, resetsAt, planType, limitId });
	}
	if (status === 429 && type === "usage_not_included") {
		return new ApiError(
			`Your ChatGPT plan does not include this usage.${message ? ` ${message}` : ""}`,
			details,
		);
	}
	const label = message ?? (response.statusText || "no details");
	return new ApiError(`Image request failed (HTTP ${status}): ${label}`, details);
}

function errorMessageFromBody(body: Record<string, unknown>): string | undefined {
	if (typeof body.detail === "string") return body.detail;
	if (isRecord(body.detail)) return str(body.detail.message) ?? str(body.detail.detail) ?? JSON.stringify(body.detail);
	if (typeof body.error === "string") return body.error;
	if (isRecord(body.error)) return str(body.error.message) ?? str(body.error.code) ?? str(body.error.type);
	return str(body.message);
}

/** A non-JSON error body is usually an HTML block page; show something readable. */
function plainText(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	if (/^<(!doctype|html)/i.test(trimmed)) {
		const title = /<title[^>]*>([^<]*)<\/title>/i.exec(trimmed)?.[1]?.trim();
		return title ? `the server returned an HTML page titled "${title}"` : "the server returned an HTML page";
	}
	return trimmed.slice(0, 500);
}

function resetTime(error: Record<string, unknown> | undefined): Date | undefined {
	const at = error?.resets_at;
	if (typeof at === "number" && Number.isFinite(at)) return new Date(at * 1000);
	const within = error?.resets_in_seconds;
	if (typeof within === "number" && Number.isFinite(within)) return new Date(Date.now() + within * 1000);
	return undefined;
}

function diagnosticHeaders(headers: Headers): Record<string, string> {
	const kept: Record<string, string> = {};
	headers.forEach((value, name) => {
		if (/^(x-codex-|x-oai-|x-request-id$|openai-|cf-ray$)/i.test(name)) kept[name] = value;
	});
	return kept;
}

async function backoff(attempt: number, signal: AbortSignal): Promise<void> {
	const delay = Math.min(1000 * 2 ** attempt, 8000);
	await new Promise<void>(resolve => {
		const timer = setTimeout(done, delay);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

function shapeOf(width: number, height: number): "square" | "landscape" | "portrait" {
	return width === height ? "square" : width > height ? "landscape" : "portrait";
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
