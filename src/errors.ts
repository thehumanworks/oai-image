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
}

/** The backend answered with a non-2xx status. */
export class ApiError extends OaiImageError implements ApiErrorDetails {
	readonly status: number;
	readonly code?: string;
	readonly type?: string;
	readonly body?: string;
	readonly requestId?: string;
	readonly imagegenRequestId?: string;

	constructor(message: string, details: ApiErrorDetails, options?: ErrorOptions) {
		super(message, options);
		this.status = details.status;
		this.code = details.code;
		this.type = details.type;
		this.body = details.body;
		this.requestId = details.requestId;
		this.imagegenRequestId = details.imagegenRequestId;
	}
}

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
