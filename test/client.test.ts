import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { AuthManager, StaticTokenAuth } from "../src/auth/manager.ts";
import { MemoryTokenStore } from "../src/auth/store.ts";
import { OaiImage } from "../src/client.ts";
import { CODEX_COMPAT_VERSION, PACKAGE_VERSION } from "../src/constants.ts";
import { ApiError, AuthRequiredError, OaiImageError, ResponseError, UsageLimitError, ValidationError } from "../src/errors.ts";
import {
	accessToken,
	gifBytes,
	imageResponse,
	type MockServer,
	mockServer,
	pngBytes,
	type RecordedRequest,
	type Reply,
	tempDir,
} from "./helpers.ts";

let backend: MockServer;
let respond: (request: RecordedRequest) => Reply | Promise<Reply>;
let dir: string;
const token = accessToken();

before(async () => {
	dir = await tempDir();
	backend = await mockServer(request => respond(request));
});

after(async () => {
	await backend.close();
	await fs.rm(dir, { recursive: true, force: true });
});

function client(options: ConstructorParameters<typeof OaiImage>[0] = {}): OaiImage {
	backend.requests.length = 0;
	respond = () => ({ json: imageResponse() });
	return new OaiImage({ auth: new StaticTokenAuth(token), baseUrl: `${backend.url}/backend-api/codex`, ...options });
}

test("generate: default request to images/generations", async () => {
	const oai = client();
	respond = () => ({
		json: imageResponse(),
		headers: { "x-codex-imagegen-request-id": "req-imagegen-123", "x-request-id": "req-outer-456" },
	});
	const result = await oai.generate("a red fox in a field");

	const [request] = backend.requests;
	assert.equal(request!.method, "POST");
	assert.equal(request!.path, "/backend-api/codex/images/generations");
	assert.deepEqual(request!.json, {
		prompt: "a red fox in a field",
		background: "opaque",
		model: "gpt-image-2.6-sunburst",
		quality: "auto",
		size: "auto",
	});
	assert.equal(request!.headers.authorization, `Bearer ${token}`);
	assert.equal(request!.headers["chatgpt-account-id"], "acct-123");
	assert.equal(request!.headers.originator, "oai-image");
	assert.equal(request!.headers.version, CODEX_COMPAT_VERSION);
	assert.equal(request!.headers["content-type"], "application/json");
	assert.match(request!.headers["user-agent"]!, new RegExp(`^oai-image/${PACKAGE_VERSION.replaceAll(".", "\\.")} `));
	assert.match(request!.headers["x-codex-image-turn-id"] as string, /^[0-9a-f-]{36}$/);
	assert.equal(request!.headers["x-openai-fedramp"], undefined);
	assert.equal(request!.headers["x-openai-internal-codex-residency"], undefined);

	assert.equal(result.operation, "generate");
	assert.equal(result.model, "gpt-image-2.6-sunburst");
	assert.equal(result.reportedModel, undefined);
	assert.equal(result.images.length, 1);
	assert.deepEqual(result.images[0]!.bytes, pngBytes());
	assert.equal(result.images[0]!.generationId, "gen-1");
	assert.equal(result.images[0]!.width, 1024);
	assert.equal(result.size, "1024x1024");
	assert.equal(result.quality, "medium");
	assert.equal(result.background, "opaque");
	assert.equal(result.created, 1778832973);
	assert.equal(result.usage?.total_tokens, 1389);
	assert.equal(result.requestId, "req-outer-456");
	assert.equal(result.imagegenRequestId, "req-imagegen-123");
	assert.equal(result.responseHeaders["x-codex-imagegen-request-id"], "req-imagegen-123");
	assert.deepEqual(result.warnings, []);
	// The bulky image data is left out of `raw`; everything else is kept.
	assert.equal("data" in result.raw, false);
	assert.equal(result.raw.output_format, "png");
});

test("generate: every option reaches the wire", async () => {
	const oai = client({ model: "flare" });
	respond = () => ({ json: imageResponse([pngBytes(1536, 1024), pngBytes(1536, 1024)], { background: "transparent" }) });
	const result = await oai.generate({
		prompt: "  a sticker of a cat  ",
		size: "1536x1024",
		quality: "high",
		background: "transparent",
		n: 2,
		extraBody: { moderation: "low", complexity: "low" },
	});
	assert.deepEqual(backend.requests[0]!.json, {
		prompt: "a sticker of a cat\n\nOutput format: landscape image, 1536x1024 pixels.",
		background: "transparent",
		model: "gpt-image-2.6-flare",
		n: 2,
		quality: "high",
		size: "1536x1024",
		moderation: "low",
		complexity: "low",
	});
	assert.equal(result.prompt, "a sticker of a cat\n\nOutput format: landscape image, 1536x1024 pixels.");
	assert.equal(result.images.length, 2);
	assert.deepEqual(result.warnings, []);
});

test("generate: aspect ratio, opting out of the size hint, and per-call model", async () => {
	const oai = client();
	await oai.generate({ prompt: "a skyline", aspectRatio: "16:9", sizeHint: false, model: "gpt-image-2" });
	assert.deepEqual(backend.requests[0]!.json, {
		prompt: "a skyline",
		background: "opaque",
		model: "gpt-image-2",
		quality: "auto",
		size: "1536x864",
	});
});

test("generate: gif controls sit beside output_format", async () => {
	const oai = client();
	respond = () => ({ json: imageResponse([gifBytes()], { output_format: "gif" }) });
	const result = await oai.generate({ prompt: "a spinning star", gif: { frameCount: 12, frameDurationMs: 160 } });
	assert.deepEqual(backend.requests[0]!.json, {
		prompt: "a spinning star",
		output_format: "gif",
		frame_count: 12,
		frame_duration_ms: 160,
		background: "opaque",
		model: "gpt-image-2.6-sunburst",
		quality: "auto",
		size: "auto",
	});
	assert.equal(result.images[0]!.mimeType, "image/gif");
	assert.equal(result.images[0]!.extension, "gif");

	await oai.generate({ prompt: "defaults", gif: true });
	assert.equal(backend.requests[1]!.json.output_format, "gif");
	assert.equal("frame_count" in backend.requests[1]!.json, false);
});

test("edit: input images go to images/edits as data URLs, in order", async () => {
	const oai = client();
	const file = path.join(dir, "input.png");
	await fs.writeFile(file, pngBytes(512, 512));
	const result = await oai.edit({
		prompt: "add a red hat",
		images: [file, { fileId: "file-image" }, new Uint8Array(gifBytes())],
	});
	const [request] = backend.requests;
	assert.equal(request!.path, "/backend-api/codex/images/edits");
	assert.deepEqual(request!.json, {
		images: [
			{ image_url: `data:image/png;base64,${pngBytes(512, 512).toString("base64")}` },
			{ file_id: "file-image" },
			{ image_url: `data:image/gif;base64,${gifBytes().toString("base64")}` },
		],
		prompt: "add a red hat",
		background: "opaque",
		model: "gpt-image-2.6-sunburst",
		quality: "auto",
		size: "auto",
	});
	assert.equal(result.operation, "edit");

	// generate() with images is the same call.
	await oai.generate({ prompt: "restyle", images: [file] });
	assert.equal(backend.requests[1]!.path, "/backend-api/codex/images/edits");
});

test("validation happens before any request is made", async () => {
	const oai = client();
	await assert.rejects(oai.generate("   "), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", n: 0 }), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", n: 1.5 }), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", size: "enormous" }), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", background: "clear" as never }), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", gif: { frameCount: 99 } }), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", images: [path.join(dir, "nope.png")] }), ValidationError);
	await assert.rejects(oai.generate({ prompt: "x", images: new Array(17).fill("data:image/png;base64,AAAA") }), ValidationError);
	await assert.rejects(oai.edit({ prompt: "x", images: [] }), ValidationError);
	assert.equal(backend.requests.length, 0);
});

test("warnings: the result says when the backend did not do what was asked", async () => {
	const oai = client();
	respond = () => ({ json: imageResponse([pngBytes(1536, 1024)], { background: "opaque" }) });
	const exact = await oai.generate({ prompt: "x", size: "1024x1024", background: "transparent", n: 2, gif: true });
	assert.deepEqual(exact.warnings, [
		"Requested 1024x1024 but the backend returned 1536x1024.",
		"Requested 2 images but the backend returned 1.",
		"Requested a transparent background but the backend returned an opaque image.",
		"Requested a GIF but the backend returned image/png.",
	]);

	const shape = await oai.generate({ prompt: "x", aspectRatio: "9:16" });
	assert.deepEqual(shape.warnings, ["Requested a portrait image but the backend returned 1536x1024."]);

	// A ratio is satisfied by any canvas of the right orientation.
	respond = () => ({ json: imageResponse([pngBytes(1024, 1792)]) });
	assert.deepEqual((await oai.generate({ prompt: "x", aspectRatio: "9:16" })).warnings, []);
});

test("fedramp and region-pinned workspaces get their routing headers", async () => {
	const pinned = accessToken({ extra: { chatgpt_account_is_fedramp: true, chatgpt_data_residency: "eu" } });
	const oai = client({ auth: new StaticTokenAuth(pinned), originator: "my-app", userAgent: "my-app/1.0" });
	await oai.generate("x");
	const headers = backend.requests[0]!.headers;
	assert.equal(headers["x-openai-fedramp"], "true");
	assert.equal(headers["x-openai-internal-codex-residency"], "eu");
	assert.equal(headers.originator, "my-app");
	assert.equal(headers["user-agent"], "my-app/1.0");
});

test("401: the login is refreshed once and the request retried with the new token", async () => {
	const stale = accessToken({ nonce: "stale" });
	const fresh = accessToken({ nonce: "fresh" });
	const issuer = await mockServer(() => ({ json: { access_token: fresh, refresh_token: "refresh-2" } }));
	try {
		const store = new MemoryTokenStore({ accessToken: stale, refreshToken: "refresh-1" });
		const oai = client({ auth: new AuthManager({ issuer: issuer.url, store }) });
		respond = request =>
			request.headers.authorization === `Bearer ${fresh}`
				? { json: imageResponse() }
				: { status: 401, json: { detail: "Unauthorized" } };
		const result = await oai.generate("x");
		assert.equal(result.images.length, 1);
		assert.deepEqual(
			backend.requests.map(request => request.headers.authorization),
			[`Bearer ${stale}`, `Bearer ${fresh}`],
		);
		// Both attempts are the same logical call.
		assert.equal(backend.requests[0]!.headers["x-codex-image-turn-id"], backend.requests[1]!.headers["x-codex-image-turn-id"]);
		assert.equal(issuer.requests.length, 1);
		assert.equal((await store.load())?.refreshToken, "refresh-2");

		// Still 401 after a refresh: the login itself is bad. No third attempt.
		backend.requests.length = 0;
		respond = () => ({ status: 401, json: { detail: "Unauthorized" } });
		await assert.rejects(oai.generate("x"), (error: unknown) => {
			assert.ok(error instanceof AuthRequiredError);
			assert.match(error.message, /ChatGPT rejected the login \(Unauthorized\)/);
			assert.ok(error.cause instanceof ApiError && error.cause.status === 401);
			return true;
		});
		assert.equal(backend.requests.length, 2);
	} finally {
		await issuer.close();
	}
});

test("errors: usage limit carries the reset time, plan and limit id", async () => {
	const oai = client();
	respond = () => ({
		status: 429,
		json: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: 1_800_000_000 } },
		headers: { "x-codex-active-limit": "image_gen", "x-request-id": "req-1" },
	});
	await assert.rejects(oai.generate("x"), (error: unknown) => {
		assert.ok(error instanceof UsageLimitError);
		assert.equal(error.status, 429);
		assert.equal(error.planType, "plus");
		assert.equal(error.limitId, "image_gen");
		assert.equal(error.resetsAt?.getTime(), 1_800_000_000_000);
		assert.equal(error.requestId, "req-1");
		assert.match(error.message, /usage limit reached \(plus plan\)/);
		return true;
	});
	assert.equal(backend.requests.length, 1);
});

test("errors: backend messages are passed on verbatim in every body shape", async () => {
	const oai = client();
	const cases: Array<[Reply, RegExp, Partial<ApiError>]> = [
		[
			{ status: 400, json: { detail: "GIF output is not enabled for this request." } },
			/Image request failed \(HTTP 400\): GIF output is not enabled for this request\./,
			{ status: 400 },
		],
		[
			{
				status: 400,
				json: { error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" } },
				headers: { "x-codex-imagegen-request-id": "img-7" },
			},
			/rejected by the safety system/,
			{ status: 400, code: "moderation_blocked", type: "image_generation_user_error", imagegenRequestId: "img-7" },
		],
		[{ status: 429, json: { error: { type: "usage_not_included" } } }, /plan does not include/, { status: 429 }],
		[
			{ status: 403, text: "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>" },
			/HTTP 403\): the server returned an HTML page titled "Just a moment\.\.\."/,
			{ status: 403 },
		],
		[{ status: 500, text: "" }, /HTTP 500\)/, { status: 500 }],
	];
	for (const [reply, message, fields] of cases) {
		respond = () => reply;
		await assert.rejects(oai.generate("x"), (error: unknown) => {
			assert.ok(error instanceof ApiError, String(error));
			assert.match(error.message, message);
			for (const [key, value] of Object.entries(fields)) assert.equal(error[key as keyof ApiError], value, key);
			return true;
		});
	}
});

test("errors: a 2xx without usable image data is a ResponseError", async () => {
	const oai = client();
	for (const json of [{ created: 1 }, { created: 1, data: [] }, { created: 1, data: [{ url: "https://x" }] }]) {
		respond = () => ({ json });
		await assert.rejects(oai.generate("x"), ResponseError);
	}
	respond = () => ({ text: "<html>ok</html>" });
	await assert.rejects(oai.generate("x"), /not JSON/);
});

test("retries: off by default, opt-in for 502/503/504 only", async () => {
	let calls = 0;
	const flaky = (): Reply => (++calls < 3 ? { status: 503, text: "busy" } : { json: imageResponse() });

	const cautious = client();
	respond = flaky;
	await assert.rejects(cautious.generate("x"), /HTTP 503/);
	assert.equal(calls, 1);

	calls = 0;
	const patient = client({ maxRetries: 2 });
	respond = flaky;
	const startedAt = Date.now();
	assert.equal((await patient.generate("x")).images.length, 1);
	assert.equal(calls, 3);
	assert.ok(Date.now() - startedAt >= 2500, "backs off between attempts");

	// A 400 is the caller's problem and is never retried.
	calls = 0;
	const strict = client({ maxRetries: 3 });
	respond = () => {
		calls += 1;
		return { status: 400, json: { detail: "bad" } };
	};
	await assert.rejects(strict.generate("x"), /bad/);
	assert.equal(calls, 1);
});

test("timeouts and cancellation end the call with a clear error", async () => {
	const oai = client();
	respond = () => new Promise(resolve => setTimeout(() => resolve({ json: imageResponse() }), 500));
	await assert.rejects(oai.generate({ prompt: "x", timeoutMs: 50 }), /timed out after/);

	const controller = new AbortController();
	const pending = oai.generate({ prompt: "x", signal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	await assert.rejects(pending, /cancelled/);

	const unreachable = new OaiImage({ auth: new StaticTokenAuth(token), baseUrl: "http://127.0.0.1:1/backend-api/codex" });
	await assert.rejects(unreachable.generate("x"), (error: unknown) => {
		assert.ok(error instanceof OaiImageError);
		assert.match(error.message, /Could not reach 127\.0\.0\.1:1/);
		return true;
	});
});

test("Node's five-minute fetch limit is reported as such and never retried", async () => {
	let calls = 0;
	const oai = new OaiImage({
		auth: new StaticTokenAuth(token),
		maxRetries: 2,
		fetch: async () => {
			calls++;
			// The shape undici produces when no response headers arrive in time.
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
		},
	});
	await assert.rejects(oai.generate("x"), /No response after 5 minutes/);
	assert.equal(calls, 1);
});

test("401 with a fixed token: the backend's reason is reported", async () => {
	const oai = client();
	respond = () => ({ status: 401, json: { detail: "Could not parse your authentication token. Please try signing in again." } });
	await assert.rejects(oai.generate("x"), (error: unknown) => {
		assert.ok(error instanceof AuthRequiredError);
		assert.match(error.message, /Could not parse your authentication token/);
		return true;
	});
	assert.equal(backend.requests.length, 1);
});

test("not signed in: fails before contacting the backend", async () => {
	const oai = client({ auth: new AuthManager({ store: new MemoryTokenStore() }) });
	await assert.rejects(oai.generate("x"), AuthRequiredError);
	assert.equal(backend.requests.length, 0);
});
