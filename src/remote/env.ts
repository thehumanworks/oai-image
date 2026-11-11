import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Vault } from "./vault.ts";

export interface Env {
	/** OAuth clients, grants and tokens (hashed), with props encrypted per token. */
	OAUTH_KV: KVNamespace;
	/** One Durable Object per sign-in: the encrypted ChatGPT login and its image jobs. */
	VAULT: DurableObjectNamespace<Vault>;
	/** Generated images. Objects live under `img/<job id>/`. */
	IMAGES: R2Bucket;
	/** Injected by OAuthProvider. */
	OAUTH_PROVIDER: OAuthHelpers;
	/** Public origin, e.g. `https://oai-image.example.workers.dev`. Default: the request's origin. */
	PUBLIC_URL?: string;
	/** Secret for signing image download links (`wrangler secret put IMAGE_URL_SECRET`). */
	IMAGE_URL_SECRET: string;
	/** Test overrides for the ChatGPT sign-in service and backend. */
	OAI_IMAGE_ISSUER?: string;
	OAI_IMAGE_BASE_URL?: string;
}

/**
 * What a grant carries, encrypted by the OAuth provider with a key that only
 * the grant's own tokens unwrap. `vaultKey` is the only key to the ChatGPT
 * login stored in the vault.
 */
export interface GrantProps {
	vaultId: string;
	vaultKey: string;
	email?: string;
	planType?: string;
}

export const SCOPE = "images";

/** The server's public origin without a trailing slash. */
export function publicOrigin(env: Env, request: Request): string {
	const configured = env.PUBLIC_URL?.trim();
	return (configured || new URL(request.url).origin).replace(/\/+$/, "");
}

export function vaultStub(env: Env, vaultId: string): DurableObjectStub<Vault> {
	return env.VAULT.get(env.VAULT.idFromName(vaultId));
}
