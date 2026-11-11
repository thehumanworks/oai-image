/** Base class of every error this package throws on purpose. */
export class OaiImageError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** The caller passed something the request cannot be built from. */
export class ValidationError extends OaiImageError {}

/** No usable ChatGPT login: never signed in, signed out, or the refresh token is dead. */
export class AuthRequiredError extends OaiImageError {
	/** Why a new login is needed. */
	readonly reason: "not-logged-in" | "refresh-expired" | "refresh-reused" | "refresh-revoked" | "rejected";

	constructor(message: string, reason: AuthRequiredError["reason"] = "not-logged-in", options?: ErrorOptions) {
		super(message, options);
		this.reason = reason;
	}
}

/** The sign-in flow itself failed (denied, timed out, bad callback, token endpoint error). */
export class LoginError extends OaiImageError {
	readonly code?: string;

	constructor(message: string, code?: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}

export interface ApiErrorDetails {
	status: number;
	/** `error.code` from the response body, when present. */
	code?: string;
	/** `error.type` from the response body, when present. */
	type?: string;
	/** Raw response body, truncated. */
	body?: string;
	/** `x-request-id` of the failed call. */
	requestId?: string;
	/** `x-codex-imagegen-request-id` of the failed call. */
	imagegenRequestId?: string;
	/** Whether the same request may succeed if sent again later. Default false. */
	retryable?: boolean;
	/** How long to wait before retrying, from `Retry-After` when the backend sent one. */
	retryAfterMs?: number;
	/** `cf-ray` of the failed call: Cloudflare's id for it, which OpenAI support can trace. */
	cfRay?: string;
	/** `cf-mitigated` of the failed call; `challenge` when Cloudflare served a bot check instead of the API. */
	cfMitigated?: string;
	/** `content-type` of the error body. */
	contentType?: string;
}

/** The backend answered with a non-2xx status. */
export class ApiError extends OaiImageError implements ApiErrorDetails {
	readonly status: number;
	readonly code?: string;
	readonly type?: string;
	readonly body?: string;
	readonly requestId?: string;
	readonly imagegenRequestId?: string;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly cfRay?: string;
	readonly cfMitigated?: string;
	readonly contentType?: string;

	constructor(message: string, details: ApiErrorDetails, options?: ErrorOptions) {
		super(message, options);
		this.status = details.status;
		this.code = details.code;
		this.type = details.type;
		this.body = details.body;
		this.requestId = details.requestId;
		this.imagegenRequestId = details.imagegenRequestId;
		this.retryable = details.retryable ?? false;
		this.retryAfterMs = details.retryAfterMs;
		this.cfRay = details.cfRay;
		this.cfMitigated = details.cfMitigated;
		this.contentType = details.contentType;
	}
}

/**
 * ChatGPT's edge (Cloudflare) answered with an HTML block or challenge page
 * instead of the API: usually a burst of requests, or traffic it took for a
 * bot. The request most likely never reached the image model. Retryable.
 */
export class UpstreamBlockedError extends ApiError {}

/** HTTP 429 that is not the plan's usage limit: too many requests in a short time. Retryable. */
export class RateLimitError extends ApiError {}

/** The ChatGPT plan's usage limit is exhausted (HTTP 429 `usage_limit_reached`). */
export class UsageLimitError extends ApiError {
	/** When the limit resets, if the backend said. */
	readonly resetsAt?: Date;
	readonly planType?: string;
	/** Which limit tripped, from the `x-codex-active-limit` header (e.g. `image_gen`). */
	readonly limitId?: string;

	constructor(
		message: string,
		details: ApiErrorDetails & { resetsAt?: Date; planType?: string; limitId?: string },
	) {
		super(message, details);
		this.resetsAt = details.resetsAt;
		this.planType = details.planType;
		this.limitId = details.limitId;
	}
}

/** The backend answered 2xx but the body is not a usable image response. */
export class ResponseError extends OaiImageError {}

/** Machine-readable reason for a failure, shared by the CLI and both MCP servers. */
export type ErrorCode =
	| "auth_required"
	| "login_failed"
	| "usage_limit"
	| "upstream_blocked"
	| "rate_limited"
	| "invalid_request"
	| "upstream_error"
	| "bad_response"
	| "error"
	| "internal";

export function errorCode(error: unknown): ErrorCode {
	if (error instanceof AuthRequiredError) return "auth_required";
	if (error instanceof UsageLimitError) return "usage_limit";
	if (error instanceof UpstreamBlockedError) return "upstream_blocked";
	if (error instanceof RateLimitError) return "rate_limited";
	if (error instanceof ValidationError) return "invalid_request";
	if (error instanceof LoginError) return "login_failed";
	if (error instanceof ApiError) return "upstream_error";
	if (error instanceof ResponseError) return "bad_response";
	if (error instanceof OaiImageError) return "error";
	return "internal";
}

/** What a caller needs to decide what to do about a failure, as plain JSON. */
export interface ErrorReport {
	error: ErrorCode;
	message: string;
	retryable: boolean;
	retry_after_seconds?: number;
	status?: number;
	request_id?: string;
	imagegen_request_id?: string;
	cf_ray?: string;
	resets_at?: string;
}

export function errorReport(error: unknown): ErrorReport {
	const message = error instanceof Error ? error.message : String(error);
	const report: ErrorReport = { error: errorCode(error), message, retryable: false };
	if (error instanceof ApiError) {
		report.retryable = error.retryable;
		if (error.retryAfterMs !== undefined) report.retry_after_seconds = Math.ceil(error.retryAfterMs / 1000);
		report.status = error.status;
		if (error.requestId) report.request_id = error.requestId;
		if (error.imagegenRequestId) report.imagegen_request_id = error.imagegenRequestId;
		if (error.cfRay) report.cf_ray = error.cfRay;
	}
	if (error instanceof UsageLimitError && error.resetsAt) report.resets_at = error.resetsAt.toISOString();
	return report;
}
