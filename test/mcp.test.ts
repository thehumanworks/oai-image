import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthManager } from "../src/auth/manager.ts";
import { FileTokenStore, MemoryTokenStore } from "../src/auth/store.ts";
import { OaiImage } from "../src/client.ts";
import { createMcpServer, type McpServerOptions, resolveOutputDir } from "../src/mcp.ts";
import {
	accessToken,
	cliCommand,
	idToken,
	imageResponse,
	largePng,
	type MockServer,
	mockServer,
	pngBytes,
	type RecordedRequest,
	type Reply,
	tempDir,
} from "./helpers.ts";

let issuer: MockServer;
let backend: MockServer;
let respond: (request: RecordedRequest) => Reply | Promise<Reply>;
let dir: string;
let approveDevice = false;

before(async () => {
	dir = await tempDir("oai-image-mcp-");
	issuer = await mockServer(request => {
		const route = request.path.split("?")[0];
		if (route === "/api/accounts/deviceauth/usercode") {
			return { json: { device_auth_id: "dev-1", user_code: "MCPX-0001", interval: "1" } };
		}
		if (route === "/api/accounts/deviceauth/token") {
			return approveDevice
				? { json: { authorization_code: "code", code_challenge: "c", code_verifier: "v" } }
				: { status: 403, json: {} };
		}
		if (route === "/oauth/token") {
			return { json: { id_token: idToken("mcp@example.com"), access_token: accessToken(), refresh_token: "refresh-mcp" } };
		}
		return { status: 404, text: "not found" };
	});
	backend = await mockServer(request => respond(request));
});

after(async () => {
	await issuer.close();
	await backend.close();
	await fs.rm(dir, { recursive: true, force: true });
});

function signedIn(): AuthManager {
	return new AuthManager({
		issuer: issuer.url,
		store: new MemoryTokenStore({ accessToken: accessToken(), refreshToken: "r", idToken: idToken("mcp@example.com") }),
	});
}

async function connect(options: Partial<McpServerOptions> & { authManager: AuthManager }) {
	backend.requests.length = 0;
	respond = () => ({ json: imageResponse() });
	const client = new OaiImage({ auth: options.authManager, baseUrl: `${backend.url}/backend-api/codex` });
	const server = createMcpServer({ client, outputDir: path.join(dir, "out"), ...options });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcp = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
	return { mcp, close: () => Promise.all([mcp.close(), server.close()]) };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
	return (result.content as Array<{ type: string; text?: string }>)
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

test("mcp: advertises its tools with schemas", async () => {
	const { mcp, close } = await connect({ authManager: signedIn() });
	const { tools } = await mcp.listTools();
	assert.deepEqual(tools.map(tool => tool.name).sort(), ["auth_status", "edit_image", "generate_image", "login"]);
	const generate = tools.find(tool => tool.name === "generate_image")!;
	assert.deepEqual(generate.inputSchema.required, ["prompt"]);
	assert.ok(generate.outputSchema);
	const properties = Object.keys(generate.inputSchema.properties ?? {}).sort();
	assert.deepEqual(properties, [
		"aspect_ratio",
		"background",
		"filename",
		"model",
		"n",
		"output_dir",
		"prompt",
		"quality",
		"reference_images",
		"return_image",
		"size",
	]);
	assert.deepEqual(tools.find(tool => tool.name === "edit_image")!.inputSchema.required, ["prompt", "images"]);
	assert.equal(tools.find(tool => tool.name === "auth_status")!.annotations?.readOnlyHint, true);
	assert.match(mcp.getInstructions() ?? "", /ChatGPT subscription/);
	await close();
});

test("mcp: generate_image saves the file and returns path, metadata and the image", async () => {
	const { mcp, close } = await connect({ authManager: signedIn() });
	respond = () => ({ json: imageResponse([pngBytes(1024, 1536)]) });
	const result = await mcp.callTool({
		name: "generate_image",
		arguments: { prompt: "a lighthouse at dusk", size: "portrait", quality: "low", filename: "../escape/Light House.png" },
	});
	assert.notEqual(result.isError, true, textOf(result));
	const structured = result.structuredContent as { images: Array<Record<string, unknown>>; model: string; operation: string; warnings: unknown[]; sizing: unknown };
	const expectedPath = path.join(dir, "out", "Light-House.png");
	assert.deepEqual(structured, {
		images: [{ path: expectedPath, mime_type: "image/png", width: 1024, height: 1536, bytes: pngBytes().length }],
		operation: "generate",
		model: "gpt-image-2.6-sunburst",
		sizing: {
			requested: { size: "portrait" },
			sent: { size: "1024x1536", kind: "preset", hint: "Output format: portrait image, 2:3 aspect ratio." },
			actual: { width: 1024, height: 1536, ratio: 0.67, megapixels: 1.57 },
			backend_size: "1024x1024",
		},
		warnings: [],
	});
	assert.deepEqual(await fs.readFile(expectedPath), pngBytes(1024, 1536));
	assert.match(textOf(result), /Generated 1 image \(model requested: gpt-image-2\.6-sunburst\)/);
	assert.match(textOf(result), /Light-House\.png \(1024x1536 PNG/);
	const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
	assert.deepEqual(content[1], { type: "image", data: pngBytes(1024, 1536).toString("base64"), mimeType: "image/png" });
	assert.deepEqual(backend.requests[0]!.json, {
		prompt: "a lighthouse at dusk\n\nOutput format: portrait image, 2:3 aspect ratio.",
		background: "opaque",
		model: "gpt-image-2.6-sunburst",
		quality: "low",
		size: "1024x1536",
	});

	// The same name again gets a counter instead of replacing the first file.
	const again = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x", filename: "Light House" } });
	const second = (again.structuredContent as { images: Array<{ path: string }> }).images[0]!.path;
	assert.equal(second, path.join(dir, "out", "Light-House_2.png"));
	await close();
});

test("mcp: inline images respect the size cap and return_image", async () => {
	const { mcp, close } = await connect({ authManager: signedIn(), inlineMaxBytes: 10 });
	const capped = await mcp.callTool({ name: "generate_image", arguments: { prompt: "big", n: 2 } });
	assert.equal((capped.content as unknown[]).length, 1);
	assert.match(textOf(capped), /Not shown inline \(larger than 10 B\)/);
	assert.match(textOf(capped), /Warning: Requested 2 images but the backend returned 1\./);
	await close();

	const roomy = await connect({ authManager: signedIn() });
	const hidden = await roomy.mcp.callTool({ name: "generate_image", arguments: { prompt: "quiet", return_image: false } });
	assert.equal((hidden.content as unknown[]).length, 1);
	assert.doesNotMatch(textOf(hidden), /Not shown inline/);
	await roomy.close();
});

test("mcp: edit_image and reference_images use the edits endpoint; output_dir is honoured", async () => {
	const { mcp, close } = await connect({ authManager: signedIn() });
	const source = path.join(dir, "source.png");
	await fs.writeFile(source, pngBytes(300, 200));
	const elsewhere = path.join(dir, "elsewhere");
	const edited = await mcp.callTool({
		name: "edit_image",
		arguments: { prompt: "make it night", images: [source], background: "transparent", output_dir: elsewhere },
	});
	assert.notEqual(edited.isError, true, textOf(edited));
	assert.equal(backend.requests[0]!.path, "/backend-api/codex/images/edits");
	const sent: Record<string, any> = backend.requests[0]!.json;
	assert.deepEqual(sent.images, [{ image_url: `data:image/png;base64,${pngBytes(300, 200).toString("base64")}` }]);
	assert.equal(sent.background, "transparent");
	const saved = (edited.structuredContent as { images: Array<{ path: string }>; operation: string }).images[0]!.path;
	assert.equal(path.dirname(saved), elsewhere);
	assert.match(textOf(edited), /^Edited 1 image/);
	// The original is untouched.
	assert.deepEqual(await fs.readFile(source), pngBytes(300, 200));

	await mcp.callTool({ name: "generate_image", arguments: { prompt: "in this style", reference_images: [source] } });
	assert.equal(backend.requests[1]!.path, "/backend-api/codex/images/edits");

	const missing = await mcp.callTool({ name: "edit_image", arguments: { prompt: "x", images: [path.join(dir, "nope.png")] } });
	assert.equal(missing.isError, true);
	assert.match(textOf(missing), /Input image not found/);
	await close();
});

test("mcp: failures come back as tool errors the model can act on", async () => {
	const { mcp, close } = await connect({ authManager: signedIn() });
	respond = () => ({ status: 429, json: { error: { type: "usage_limit_reached", plan_type: "plus" } } });
	const limited = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x" } });
	assert.equal(limited.isError, true);
	assert.match(textOf(limited), /usage limit reached \(plus plan\).*Do not retry until the limit resets/s);
	assert.equal((limited.structuredContent as { error: string; retryable: boolean }).error, "usage_limit");
	assert.equal((limited.structuredContent as { retryable: boolean }).retryable, false);

	respond = () => ({ status: 429, json: { error: { message: "Slow down" } }, headers: { "retry-after": "20", "x-request-id": "req-3" } });
	const throttled = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x" } });
	assert.equal(throttled.isError, true);
	assert.deepEqual(throttled.structuredContent, {
		error: "rate_limited",
		message: textOf(throttled),
		retryable: true,
		retry_after_seconds: 20,
		status: 429,
		request_id: "req-3",
	});

	respond = () => ({ status: 400, json: { error: { message: "Your request was rejected by the safety system." } } });
	const blocked = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x" } });
	assert.equal(blocked.isError, true);
	assert.match(textOf(blocked), /rejected by the safety system/);

	// Schema violations never reach the backend.
	backend.requests.length = 0;
	const invalid = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x", quality: "ultra" } }).catch(error => error);
	assert.ok(invalid instanceof Error || invalid.isError === true);
	for (const args of [{ size: "huge" }, { aspect_ratio: "wide" }, { size: "1000x1000" }]) {
		const bad = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x", ...args } }).catch(error => error);
		assert.ok(bad instanceof Error || bad.isError === true, JSON.stringify(args));
	}
	assert.equal(backend.requests.length, 0);
	await close();
});

test("mcp: progress notifications flow while an image renders", async () => {
	const { mcp, close } = await connect({ authManager: signedIn(), progressIntervalMs: 20 });
	respond = () => new Promise(resolve => setTimeout(() => resolve({ json: imageResponse() }), 150));
	const updates: Array<{ progress: number; message?: string }> = [];
	const result = await mcp.callTool({ name: "generate_image", arguments: { prompt: "slow" } }, undefined, {
		onprogress: update => updates.push(update),
	});
	assert.notEqual(result.isError, true);
	assert.ok(updates.length >= 2, `got ${updates.length} progress updates`);
	assert.match(updates[0]!.message ?? "", /Rendering/);
	await close();
});

test("mcp: signed out -> login tool -> signed in", async () => {
	approveDevice = false;
	const store = new FileTokenStore(path.join(dir, "login", "auth.json"));
	const authManager = new AuthManager({ issuer: issuer.url, store });
	const { mcp, close } = await connect({ authManager });

	const refused = await mcp.callTool({ name: "generate_image", arguments: { prompt: "x" } });
	assert.equal(refused.isError, true);
	assert.match(textOf(refused), /Not signed in.*`login` tool/s);
	assert.equal(backend.requests.length, 0);
	assert.match(textOf(await mcp.callTool({ name: "auth_status", arguments: {} })), /Not signed in\. Call the `login` tool/);

	const login = await mcp.callTool({ name: "login", arguments: {} });
	assert.notEqual(login.isError, true, textOf(login));
	assert.match(textOf(login), new RegExp(`Open ${issuer.url}/codex/device`));
	assert.match(textOf(login), /Enter the code MCPX-0001/);
	assert.match(textOf(await mcp.callTool({ name: "auth_status", arguments: {} })), /waiting for the user .* with code MCPX-0001/);

	// The user approves in their browser; the server's background poll picks it up.
	approveDevice = true;
	const deadline = Date.now() + 5000;
	let status = "";
	while (Date.now() < deadline) {
		status = textOf(await mcp.callTool({ name: "auth_status", arguments: {} }));
		if (/Signed in as/.test(status)) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.match(status, /Signed in as mcp@example\.com on the plus plan/);
	assert.equal((await store.load())?.refreshToken, "refresh-mcp");

	const generated = await mcp.callTool({ name: "generate_image", arguments: { prompt: "now it works" } });
	assert.notEqual(generated.isError, true, textOf(generated));
	await close();
});

test("mcp: default output directory", async () => {
	const previous = process.env.OAI_IMAGE_OUTPUT_DIR;
	try {
		delete process.env.OAI_IMAGE_OUTPUT_DIR;
		assert.equal(await resolveOutputDir(), path.join(process.cwd(), "generated_images"));
		assert.equal(await resolveOutputDir("/tmp/explicit"), "/tmp/explicit");
		process.env.OAI_IMAGE_OUTPUT_DIR = "/tmp/from-env";
		assert.equal(await resolveOutputDir(), "/tmp/from-env");
		assert.equal(await resolveOutputDir("/tmp/explicit"), "/tmp/explicit");
	} finally {
		if (previous === undefined) delete process.env.OAI_IMAGE_OUTPUT_DIR;
		else process.env.OAI_IMAGE_OUTPUT_DIR = previous;
	}
});

test("mcp: the stdio server speaks clean JSON-RPC on stdout", async () => {
	respond = () => ({ json: imageResponse() });
	backend.requests.length = 0;
	const work = path.join(dir, "stdio");
	await fs.mkdir(work, { recursive: true });
	// Bun-compiled executables read `.env` from the working directory unless built
	// not to; the saved path below shows this one was ignored.
	await fs.writeFile(path.join(work, ".env"), `OAI_IMAGE_OUTPUT_DIR=${path.join(dir, "from-dotenv")}\n`);
	const transport = new StdioClientTransport({
		...cliCommand(["mcp"]),
		cwd: work,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			OAI_IMAGE_HOME: path.join(dir, "stdio-state"),
			OAI_IMAGE_BASE_URL: `${backend.url}/backend-api/codex`,
			OAI_IMAGE_ISSUER: issuer.url,
			OAI_IMAGE_ACCESS_TOKEN: accessToken({ accountId: "acct-stdio" }),
			NODE_NO_WARNINGS: "1",
		},
		stderr: "pipe",
	});
	const mcp = new Client({ name: "stdio-test", version: "0" });
	await mcp.connect(transport);
	try {
		assert.equal(mcp.getServerVersion()?.name, "oai-image");
		assert.equal((await mcp.listTools()).tools.length, 4);
		assert.match(textOf(await mcp.callTool({ name: "auth_status", arguments: {} })), /OAI_IMAGE_ACCESS_TOKEN/);
		const result = await mcp.callTool({ name: "generate_image", arguments: { prompt: "over stdio" } });
		assert.notEqual(result.isError, true, textOf(result));
		const saved = (result.structuredContent as { images: Array<{ path: string }> }).images[0]!.path;
		assert.equal(path.dirname(saved), path.join(await fs.realpath(work), "generated_images"));
		assert.equal(backend.requests[0]!.headers["chatgpt-account-id"], "acct-stdio");

		// An inline image just under the default cap, as one multi-megabyte JSON-RPC line.
		const image = largePng(3 * 1024 * 1024 - 1000);
		respond = () => ({ json: imageResponse([image]) });
		const big = await mcp.callTool({ name: "generate_image", arguments: { prompt: "big over stdio" } });
		assert.notEqual(big.isError, true, textOf(big));
		const inline = (big.content as Array<{ type: string; data?: string }>).find(part => part.type === "image");
		assert.ok(inline?.data, "expected the image inline");
		assert.ok(Buffer.from(inline.data, "base64").equals(image));
	} finally {
		await mcp.close();
	}
});
