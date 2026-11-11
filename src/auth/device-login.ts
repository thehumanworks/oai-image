import { DEVICE_LOGIN_TIMEOUT_MS } from "../constants.ts";
import { LoginError } from "../errors.ts";
import { describe, exchangeCodeForTokens, type OAuthConfig, resolveOAuthConfig, withTimeout } from "./oauth.ts";
import type { StoredTokens } from "./store.ts";

export interface DeviceLoginOptions extends OAuthConfig {
	signal?: AbortSignal;
	/** Give up after this long. Default 15 minutes, the lifetime of the code. */
	timeoutMs?: number;
	/** Override the polling interval the server asks for. */
	pollIntervalMs?: number;
}

export interface DeviceLogin {
	/** Page where the user enters the code. */
	readonly verificationUrl: string;
	/** One-time code to enter on that page. */
	readonly userCode: string;
	readonly expiresAt: Date;
	/** Poll until the user approves, then resolve with tokens. */
	wait(): Promise<StoredTokens>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** A device code issued by the sign-in service, before the user has approved it. */
export interface DeviceCode {
	/** Opaque id used to poll for the user's approval. Keep it private. */
	deviceAuthId: string;
	/** One-time code the user types on {@link verificationUrl}. */
	userCode: string;
	verificationUrl: string;
	/** Polling interval the service asks for. */
	intervalMs: number;
}

/** Ask the sign-in service for a device code. Nothing is polled yet. */
export async function requestDeviceCode(options: OAuthConfig & { signal?: AbortSignal } = {}): Promise<DeviceCode> {
	const config = resolveOAuthConfig(options);
	let response: Response;
	try {
		response = await config.fetch(`${config.issuer}/api/accounts/deviceauth/usercode`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: config.clientId }),
			signal: withTimeout(REQUEST_TIMEOUT_MS, options.signal),
		});
	} catch (cause) {
		throw new LoginError(`Could not reach the sign-in service: ${describe(cause)}`, "network", { cause });
	}
	if (!response.ok) {
		await response.arrayBuffer().catch(() => undefined);
		throw new LoginError(
			response.status === 404
				? "Device-code login is not available from this sign-in service. Use the browser login instead."
				: `Requesting a device code failed with status ${response.status}`,
			`http_${response.status}`,
		);
	}
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	const deviceAuthId = typeof body?.device_auth_id === "string" ? body.device_auth_id : undefined;
	const userCode = [body?.user_code, body?.usercode].find((value): value is string => typeof value === "string");
	if (!deviceAuthId || !userCode) {
		throw new LoginError("The sign-in service returned an unreadable device code", "invalid_response");
	}
	// The interval arrives as a string of seconds.
	const interval = Number.parseInt(String(body?.interval ?? ""), 10);
	return {
		deviceAuthId,
		userCode,
		verificationUrl: `${config.issuer}/codex/device`,
		intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
	};
}

/**
 * Ask once whether the user has approved a device code.
 *
 * @returns the tokens once approved, or `undefined` while the user has not answered yet.
 * A dropped connection also counts as "not yet": it is not the user's answer.
 */
export async function pollDeviceCode(
	code: Pick<DeviceCode, "deviceAuthId" | "userCode">,
	options: OAuthConfig & { signal?: AbortSignal } = {},
): Promise<StoredTokens | undefined> {
	const config = resolveOAuthConfig(options);
	let poll: Response;
	try {
		poll = await config.fetch(`${config.issuer}/api/accounts/deviceauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
			signal: withTimeout(REQUEST_TIMEOUT_MS, options.signal),
		});
	} catch (cause) {
		if (options.signal?.aborted) throw new LoginError("Login cancelled", "cancelled", { cause });
		return undefined;
	}
	// 403 and 404 both mean "not approved yet".
	if (poll.status === 403 || poll.status === 404) {
		await poll.arrayBuffer().catch(() => undefined);
		return undefined;
	}
	if (!poll.ok) {
		await poll.arrayBuffer().catch(() => undefined);
		throw new LoginError(`Device-code sign-in failed with status ${poll.status}`, `http_${poll.status}`);
	}
	const approved = (await poll.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	const authorizationCode = typeof approved?.authorization_code === "string" ? approved.authorization_code : undefined;
	const verifier = typeof approved?.code_verifier === "string" ? approved.code_verifier : undefined;
	if (!authorizationCode || !verifier) {
		throw new LoginError("The sign-in service returned an unreadable device approval", "invalid_response");
	}
	// The server ran PKCE on our behalf and hands back the verifier to redeem the code with.
	return exchangeCodeForTokens(config, {
		code: authorizationCode,
		verifier,
		redirectUri: `${config.issuer}/deviceauth/callback`,
		signal: options.signal,
	});
}

/**
 * Start the device-code sign-in, for machines without a browser or where the
 * loopback callback port cannot be reached (SSH, containers, CI).
 */
export async function startDeviceLogin(options: DeviceLoginOptions = {}): Promise<DeviceLogin> {
	const config = resolveOAuthConfig(options);
	const timeoutMs = options.timeoutMs ?? DEVICE_LOGIN_TIMEOUT_MS;
	const code = await requestDeviceCode({ ...config, signal: options.signal });
	const intervalMs = options.pollIntervalMs ?? code.intervalMs;
	const startedAt = Date.now();

	const wait = async (): Promise<StoredTokens> => {
		for (;;) {
			const remaining = timeoutMs - (Date.now() - startedAt);
			if (remaining <= 0) throw new LoginError("The device code expired before sign-in finished", "timeout");
			await sleep(Math.min(intervalMs, remaining), options.signal);
			const tokens = await pollDeviceCode(code, { ...config, signal: options.signal });
			if (tokens) return tokens;
		}
	};

	return {
		verificationUrl: code.verificationUrl,
		userCode: code.userCode,
		expiresAt: new Date(startedAt + timeoutMs),
		wait,
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new LoginError("Login cancelled", "cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new LoginError("Login cancelled", "cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
