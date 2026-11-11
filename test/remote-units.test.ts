import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64url, base64url, hmacSha256, newKeyMaterial, randomToken, safeEqual, seal, unseal } from "../src/remote/crypto.ts";

test("remote crypto: sealed data opens only with the same key and context", async () => {
	const key = newKeyMaterial();
	const sealed = await seal(key, '{"refreshToken":"secret"}', "vault/a");
	assert.doesNotMatch(JSON.stringify(sealed), /secret/);
	assert.equal(await unseal(key, sealed, "vault/a"), '{"refreshToken":"secret"}');
	await assert.rejects(unseal(newKeyMaterial(), sealed, "vault/a"));
	await assert.rejects(unseal(key, sealed, "vault/b"));
	const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("A") ? "BB" : "AA") };
	await assert.rejects(unseal(key, tampered, "vault/a"));
});

test("remote crypto: tokens are random and base64url round-trips", async () => {
	assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(randomToken(), randomToken());
	const bytes = crypto.getRandomValues(new Uint8Array(57));
	assert.deepEqual(fromBase64url(base64url(bytes)), bytes);
	assert.equal(safeEqual("abc", "abc"), true);
	assert.equal(safeEqual("abc", "abd"), false);
	assert.equal(safeEqual("abc", "abcd"), false);
	assert.equal(await hmacSha256("k", "m"), await hmacSha256("k", "m"));
	assert.notEqual(await hmacSha256("k", "m"), await hmacSha256("k2", "m"));
});
