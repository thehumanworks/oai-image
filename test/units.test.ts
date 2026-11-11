import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { decodeJwtPayload, jwtExpiresAt, readIdentity } from "../src/auth/jwt.ts";
import { generatePkce } from "../src/auth/pkce.ts";
import { DEFAULT_IMAGE_MODEL, PACKAGE_VERSION, resolveModel } from "../src/constants.ts";
import { ValidationError } from "../src/errors.ts";
import { readImageSize, sniffImageFormat } from "../src/image-format.ts";
import { toImageReference } from "../src/input.ts";
import { GeneratedImage, saveImages, slugify } from "../src/output.ts";
import { resolveSize, sizeHint } from "../src/size.ts";
import { gifBytes, makeJwt, pngBytes, tempDir } from "./helpers.ts";
import { createHash } from "node:crypto";

test("package version constant matches package.json", async () => {
	const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(PACKAGE_VERSION, manifest.version);
});

test("jwt: reads identity from access and id tokens", () => {
	const access = makeJwt({
		exp: 2_000_000_000,
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-access", chatgpt_user_id: "user-9" },
	});
	const id = makeJwt({
		email: "Someone@Example.COM",
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-id", chatgpt_plan_type: "Pro" },
	});
	assert.equal(jwtExpiresAt(access), 2_000_000_000_000);
	assert.deepEqual(readIdentity(access, id), {
		email: "someone@example.com",
		planType: "pro",
		userId: "user-9",
		accountId: "acct-access",
		isFedramp: false,
		residency: undefined,
	});
});

test("jwt: residency ignores the unconstrained sentinel and malformed tokens are tolerated", () => {
	const pinned = makeJwt({ "https://api.openai.com/auth": { chatgpt_data_residency: "eu", chatgpt_account_is_fedramp: true } });
	assert.equal(readIdentity(pinned).residency, "eu");
	assert.equal(readIdentity(pinned).isFedramp, true);
	const free = makeJwt({
		"https://api.openai.com/auth": { chatgpt_data_residency: "no_constraint", chatgpt_compute_residency: "us" },
	});
	assert.equal(readIdentity(free).residency, undefined);
	assert.equal(decodeJwtPayload("not-a-jwt"), undefined);
	assert.equal(decodeJwtPayload("a.b"), undefined);
	assert.equal(jwtExpiresAt("opaque-token"), undefined);
	assert.deepEqual(readIdentity("opaque-token").accountId, undefined);
});

test("pkce: challenge is the S256 of the verifier", () => {
	const { verifier, challenge } = generatePkce();
	assert.ok(verifier.length >= 43 && verifier.length <= 128);
	assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("models: aliases resolve and unknown ids pass through", () => {
	assert.equal(resolveModel(), DEFAULT_IMAGE_MODEL);
	assert.equal(resolveModel("gpt-image-2.6"), "gpt-image-2.6-sunburst");
	assert.equal(resolveModel("Flare"), "gpt-image-2.6-flare");
	assert.equal(resolveModel("gpt-image-2"), "gpt-image-2");
	assert.equal(resolveModel("some-future-model"), "some-future-model");
});

test("size: names, pixels, ratios", () => {
	assert.deepEqual(resolveSize(), { size: "auto", exact: false });
	assert.equal(resolveSize("AUTO").size, "auto");
	assert.equal(resolveSize("landscape").size, "1536x1024");
	assert.equal(resolveSize("landscape").exact, false);
	assert.deepEqual(resolveSize("2048x1152"), {
		size: "2048x1152",
		width: 2048,
		height: 1152,
		shape: "landscape",
		ratio: "16:9",
		exact: true,
	});
	assert.equal(resolveSize(undefined, "16:9").size, "1536x864");
	assert.equal(resolveSize(undefined, "9:16").size, "864x1536");
	assert.equal(resolveSize(undefined, "1:1").size, "1024x1024");
	assert.equal(resolveSize(undefined, "2:3").size, "1024x1536");
	assert.equal(resolveSize("auto", "3:1").size, "1536x512");
});

test("size: every ratio-derived size satisfies the documented limits", () => {
	for (const ratio of ["16:9", "9:16", "4:3", "3:4", "5:4", "21:9", "3:1", "1:3", "2:1", "1.85:1"]) {
		const { width, height } = resolveSize(undefined, ratio) as { width: number; height: number };
		assert.equal(width % 16, 0, ratio);
		assert.equal(height % 16, 0, ratio);
		assert.ok(width * height >= 655_360 && width * height <= 8_294_400, `${ratio} -> ${width}x${height}`);
		assert.ok(Math.max(width / height, height / width) <= 3.01, ratio);
	}
});

test("size: rejects bad input", () => {
	assert.throws(() => resolveSize("huge"), ValidationError);
	assert.throws(() => resolveSize("1024x1024", "16:9"), ValidationError);
	assert.throws(() => resolveSize(undefined, "wide"), ValidationError);
	assert.throws(() => resolveSize(undefined, "4:1"), ValidationError);
	assert.throws(() => resolveSize(undefined, "0:1"), ValidationError);
});

test("size: hint wording", () => {
	assert.equal(sizeHint(resolveSize()), undefined);
	assert.equal(sizeHint(resolveSize("1024x1536")), "Output format: portrait image, 1024x1536 pixels.");
	assert.equal(sizeHint(resolveSize(undefined, "16:9")), "Output format: landscape image, 16:9 aspect ratio.");
	assert.equal(sizeHint(resolveSize("square")), "Output format: square image, 1:1 aspect ratio.");
});

test("image format: sniffing and dimensions", () => {
	assert.deepEqual(sniffImageFormat(pngBytes()), { mimeType: "image/png", extension: "png" });
	assert.deepEqual(readImageSize(pngBytes(1536, 1024)), { width: 1536, height: 1024 });
	assert.equal(sniffImageFormat(gifBytes())?.mimeType, "image/gif");
	assert.deepEqual(readImageSize(gifBytes(64, 48)), { width: 64, height: 48 });
	assert.equal(sniffImageFormat(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'))?.extension, "svg");
	assert.equal(sniffImageFormat(Buffer.from("plain text")), undefined);
	assert.equal(readImageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), undefined);

	// Baseline JPEG: SOI, APP0, then SOF0 with height 300 and width 400.
	const jpeg = Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0x01,
		0x22, 0x00,
	]);
	assert.equal(sniffImageFormat(jpeg)?.extension, "jpg");
	assert.deepEqual(readImageSize(jpeg), { width: 400, height: 300 });

	// Extended WebP (VP8X) stores width-1 and height-1 as 24-bit little endian.
	const webp = Buffer.alloc(30);
	webp.write("RIFF", 0, "ascii");
	webp.write("WEBP", 8, "ascii");
	webp.write("VP8X", 12, "ascii");
	webp.writeUIntLE(1535, 24, 3);
	webp.writeUIntLE(1023, 27, 3);
	assert.equal(sniffImageFormat(webp)?.mimeType, "image/webp");
	assert.deepEqual(readImageSize(webp), { width: 1536, height: 1024 });
});

test("input: files, bytes, data URLs, remote URLs and file ids", async () => {
	const dir = await tempDir();
	const file = path.join(dir, "photo.jpg");
	// The name says JPEG but the bytes are PNG; the bytes win.
	await fs.writeFile(file, pngBytes());
	const expected = `data:image/png;base64,${pngBytes().toString("base64")}`;
	assert.deepEqual(await toImageReference(file), { image_url: expected });
	assert.deepEqual(await toImageReference(new URL(`file://${file}`)), { image_url: expected });
	assert.deepEqual(await toImageReference(new Uint8Array(pngBytes())), { image_url: expected });
	assert.deepEqual(await toImageReference({ data: pngBytes().toString("base64") }), { image_url: expected });
	assert.deepEqual(await toImageReference(expected), { image_url: expected });
	assert.deepEqual(await toImageReference("https://example.com/a.png"), { image_url: "https://example.com/a.png" });
	assert.deepEqual(await toImageReference({ fileId: "file-abc" }), { file_id: "file-abc" });

	await assert.rejects(toImageReference(path.join(dir, "missing.png")), /not found/);
	await assert.rejects(toImageReference(dir), /not a file/);
	await assert.rejects(toImageReference("data:text/plain;base64,aGk="), ValidationError);
	const notImage = path.join(dir, "notes.txt");
	await fs.writeFile(notImage, "hello");
	await assert.rejects(toImageReference(notImage), /not a recognized image/);
	await fs.rm(dir, { recursive: true });
});

test("output: generated names never collide and explicit files are not overwritten", async () => {
	const dir = await tempDir();
	const image = new GeneratedImage(pngBytes(640, 480).toString("base64"), 0, "gen-1");
	assert.equal(image.mimeType, "image/png");
	assert.equal(image.width, 640);
	assert.equal(image.height, 480);
	assert.ok(image.toDataUrl().startsWith("data:image/png;base64,"));

	const now = new Date(2026, 10, 10, 9, 5, 7);
	const first = await saveImages([image], { dir, nameHint: "A Red Fox, in a field!", now });
	const second = await saveImages([image], { dir, nameHint: "A Red Fox, in a field!", now });
	assert.equal(path.basename(first[0]!.path), "oai-image-20261110-090507-a-red-fox-in-a-field.png");
	assert.equal(path.basename(second[0]!.path), "oai-image-20261110-090507-a-red-fox-in-a-field_2.png");

	const pair = await saveImages([image, image], { dir, baseName: "../../etc/hero shot.png" });
	assert.deepEqual(pair.map(entry => path.relative(dir, entry.path)), ["hero-shot-1.png", "hero-shot-2.png"]);

	const explicit = path.join(dir, "nested", "out");
	const saved = await saveImages([image, image], { file: explicit });
	assert.deepEqual(saved.map(entry => path.relative(dir, entry.path)), [
		path.join("nested", "out.png"),
		path.join("nested", "out-2.png"),
	]);
	await assert.rejects(saveImages([image], { file: explicit }), /already exists/);
	await saveImages([image], { file: explicit, overwrite: true });
	assert.deepEqual(await fs.readFile(`${explicit}.png`), pngBytes(640, 480));
	await fs.rm(dir, { recursive: true });
});

test("output: slugify", () => {
	assert.equal(slugify("Crème brûlée — close-up"), "creme-brulee-close-up");
	assert.equal(slugify("   "), "");
	assert.ok(slugify("x".repeat(200)).length <= 40);
});
