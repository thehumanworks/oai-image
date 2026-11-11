const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

/** Residency claim value of an account that is not pinned to a region. */
const UNCONSTRAINED_RESIDENCY = "no_constraint";

/** Identity read from ChatGPT token claims. Claims are not verified; treat them as hints. */
export interface TokenIdentity {
	email?: string;
	/** ChatGPT plan, e.g. `plus`, `pro`, `business`. */
	planType?: string;
	userId?: string;
	/** Workspace the token draws its limits from; sent as `chatgpt-account-id`. */
	accountId?: string;
	isFedramp: boolean;
	/** Data residency of a region-pinned workspace. */
	residency?: string;
}

/** Decode a JWT payload without verifying the signature. Returns undefined for anything malformed. */
export function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> | undefined {
	if (!jwt) return undefined;
	const parts = jwt.split(".");
	if (parts.length !== 3 || parts.some(part => part.length === 0)) return undefined;
	try {
		const payload: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

/** Expiry of a JWT in epoch milliseconds, from its `exp` claim. */
export function jwtExpiresAt(jwt: string | undefined): number | undefined {
	const exp = decodeJwtPayload(jwt)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/**
 * Read the ChatGPT identity from token claims. The access token is
 * authoritative for the workspace; the id token usually carries the plan.
 */
export function readIdentity(accessToken: string | undefined, idToken?: string): TokenIdentity {
	const access = decodeJwtPayload(accessToken);
	const id = decodeJwtPayload(idToken);
	const accessAuth = record(access?.[AUTH_CLAIM]);
	const idAuth = record(id?.[AUTH_CLAIM]);
	const pick = (key: string) => str(accessAuth?.[key]) ?? str(idAuth?.[key]);

	const email =
		str(id?.email) ??
		str(record(id?.[PROFILE_CLAIM])?.email) ??
		str(access?.email) ??
		str(record(access?.[PROFILE_CLAIM])?.email);

	let residency: string | undefined;
	for (const claim of [pick("chatgpt_data_residency"), pick("chatgpt_compute_residency")]) {
		if (!claim) continue;
		// The first present claim wins, so an unconstrained data residency is not
		// overridden by a compute residency.
		residency = claim.toLowerCase() === UNCONSTRAINED_RESIDENCY ? undefined : claim;
		break;
	}

	return {
		email: email?.toLowerCase(),
		planType: pick("chatgpt_plan_type")?.toLowerCase(),
		userId: pick("chatgpt_user_id") ?? pick("user_id"),
		accountId: pick("chatgpt_account_id"),
		isFedramp: accessAuth?.chatgpt_account_is_fedramp === true || idAuth?.chatgpt_account_is_fedramp === true,
		residency,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
