/**
 * Small Web Crypto helpers for the hosted server. Everything here runs in
 * Cloudflare Workers and in Node 20+, which share the Web Crypto API.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** An unguessable identifier: `bytes` random bytes, base64url encoded (32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Fresh AES-256 key material, base64url encoded. */
export function newKeyMaterial(): string {
	return randomToken(32);
}

export interface Sealed {
	iv: string;
	ct: string;
}

async function aesKey(material: string) {
	const raw = fromBase64url(material);
	if (raw.length !== 32) throw new Error("Key material must be 32 bytes");
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt `plaintext` with AES-256-GCM. `context` is bound as additional
 * data, so a ciphertext copied to another record does not decrypt there.
 */
export async function seal(material: string, plaintext: string, context: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(context) },
		await aesKey(material),
		encoder.encode(plaintext),
	);
	return { iv: base64url(iv), ct: base64url(new Uint8Array(ct)) };
}

/** Reverse of {@link seal}. Throws when the key or context is wrong or the data was altered. */
export async function unseal(material: string, sealed: Sealed, context: string): Promise<string> {
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64url(sealed.iv), additionalData: encoder.encode(context) },
		await aesKey(material),
		fromBase64url(sealed.ct),
	);
	return decoder.decode(pt);
}

export async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}
