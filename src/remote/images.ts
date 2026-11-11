import { hmacSha256, safeEqual } from "./crypto.ts";
import type { Env } from "./env.ts";

/** Download links stay valid for as long as the job is kept. */
export const IMAGE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const IMAGE_PATH = /^\/images\/(img\/[A-Za-z0-9_-]{16,64}\/\d{1,2}\.[a-z]{3,4})$/;

/**
 * A link to one generated image that works without a token, so it can be
 * opened in a browser. It is signed and expires; the object key itself is
 * random and never reused.
 */
export async function signedImageUrl(env: Env, origin: string, key: string, now = Date.now()): Promise<string> {
	const expires = Math.floor((now + IMAGE_LINK_TTL_MS) / 1000);
	const signature = await hmacSha256(secret(env), `${key}|${expires}`);
	return `${origin}/images/${key}?exp=${expires}&sig=${signature}`;
}

/** Serve `GET /images/<key>?exp=&sig=`. Returns undefined when the path is not an image link. */
export async function serveImage(request: Request, env: Env): Promise<Response | undefined> {
	const url = new URL(request.url);
	const match = IMAGE_PATH.exec(url.pathname);
	if (!match) return undefined;
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
	const key = match[1] as string;
	const expires = Number(url.searchParams.get("exp"));
	const signature = url.searchParams.get("sig") ?? "";
	if (!Number.isInteger(expires) || expires * 1000 < Date.now()) return notFound();
	const expected = await hmacSha256(secret(env), `${key}|${expires}`);
	if (!safeEqual(signature, expected)) return notFound();
	const object = await env.IMAGES.get(key);
	if (!object) return notFound();
	const headers = new Headers({
		"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
		"Cache-Control": "private, max-age=3600",
		"Content-Disposition": `inline; filename="${key.split("/").pop()}"`,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Referrer-Policy": "no-referrer",
	});
	return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

function secret(env: Env): string {
	const value = env.IMAGE_URL_SECRET;
	if (!value || value.length < 32) {
		throw new Error("IMAGE_URL_SECRET is not set or shorter than 32 characters. Run `wrangler secret put IMAGE_URL_SECRET`.");
	}
	return value;
}

function notFound(): Response {
	return new Response("Not found or link expired", { status: 404, headers: { "Content-Type": "text/plain" } });
}
