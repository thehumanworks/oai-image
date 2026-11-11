import { createHash, randomBytes } from "node:crypto";

export interface PkceCodes {
	verifier: string;
	challenge: string;
}

/** PKCE verifier and S256 challenge, built the way Codex builds them (64 random bytes). */
export function generatePkce(): PkceCodes {
	const verifier = randomBytes(64).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function generateState(): string {
	return randomBytes(32).toString("base64url");
}
