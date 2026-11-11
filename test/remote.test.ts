/**
 * End-to-end tests of the hosted server (src/remote) running in workerd via
 * `wrangler dev --env test`, against local mocks of OpenAI's sign-in service
 * and image backend. Covers OAuth discovery and registration, consent, the
 * device-code ChatGPT sign-in, the 2026-07-28 stateless protocol with the
 * Tasks extension, the 2025 fallback, image links, tenant isolation, token
 * refresh and sign-out.
 *
 * Skipped unless OAI_IMAGE_REMOTE_TESTS=1, since it starts workerd (`npm run test:remote`).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { accessToken, imageResponse, makeJwt, type MockServer, mockServer, pngBytes, tempDir } from "./helpers.ts";

const enabled = process.env.OAI_IMAGE_REMOTE_TESTS === "1";
const PROTOCOL = "2026-07-28";
const TASKS = "io.modelcontextprotocol/tasks";
const REDIRECT_URI = "http://127.0.0.1:65530/callback";

let issuer: MockServer;
let backend: MockServer;
let worker: ChildProcess | undefined;
let base = "";
let persistDir = "";
let approve = false;
let nextIdentity = { email: "first@example.com", userId: "user-first", accountId: "acct-first", expiresIn: 3600 };
let renderDelayMs = 1500;
let refreshFails = false;

before(async () => {
	if (!enabled) return;
	issuer = await mockServer(request => {
		const route = request.path.split("?")[0];
		if (route === "/api/accounts/deviceauth/usercode") {
			return { json: { device_auth_id: `dev-${randomBytes(4).toString("hex")}`, user_code: "ABCD-1234", interval: "1" } };
		}
		if (route === "/api/accounts/deviceauth/token") {
			return approve ? { json: { authorization_code: "auth-code", code_verifier: "verifier" } } : { status: 403, json: {} };
		}
		if (route === "/oauth/token") {
			const identity = nextIdentity;
			const isRefresh = request.json?.grant_type === "refresh_token";
			if (isRefresh && refreshFails) return { status: 401, json: { error: { code: "refresh_token_expired", message: "expired" } } };
			return {
				json: {
					access_token: accessToken({
						accountId: identity.accountId,
						expiresInSeconds: isRefresh ? 3600 : identity.expiresIn,
						nonce: randomBytes(4).toString("hex"),
						extra: { chatgpt_user_id: identity.userId },
					}),
					refresh_token: `refresh-${randomBytes(4).toString("hex")}`,
					id_token: makeJwt({
						email: identity.email,
						"https://api.openai.com/auth": { chatgpt_account_id: identity.accountId, chatgpt_plan_type: "plus" },
					}),
				},
			};
		}
		if (route === "/oauth/revoke") return { json: {} };
		return { status: 404, text: "not found" };
	});
	backend = await mockServer(async request => {
		await new Promise(resolve => setTimeout(resolve, renderDelayMs));
		const size = request.json?.size === "1536x1024" ? [1536, 1024] : [1024, 1024];
		return { json: imageResponse([pngBytes(size[0], size[1])]) };
	});
	persistDir = await tempDir("oai-image-remote-");
	const port = await freePort();
	base = `http://127.0.0.1:${port}`;
	worker = spawn(
		process.execPath,
		[
			"node_modules/wrangler/bin/wrangler.js",
			"dev",
			"--env",
			"test",
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
			"--inspector-port",
			String(await freePort()),
			"--persist-to",
			persistDir,
			"--show-interactive-dev-session=false",
			"--var",
			`OAI_IMAGE_ISSUER:${issuer.url}`,
			"--var",
			`OAI_IMAGE_BASE_URL:${backend.url}/backend-api/codex`,
			"--var",
			`IMAGE_URL_SECRET:${randomBytes(32).toString("hex")}`,
		],
		{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" } },
	);
	let log = "";
	worker.stdout?.on("data", chunk => (log += chunk));
	worker.stderr?.on("data", chunk => (log += chunk));
	const deadline = Date.now() + 90_000;
	for (;;) {
		try {
			const response = await fetch(`${base}/`);
			if (response.ok) break;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline || worker.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
		await new Promise(resolve => setTimeout(resolve, 500));
	}
});

after(async () => {
	if (!enabled) return;
	worker?.kill("SIGTERM");
	await issuer.close();
	await backend.close();
	await fs.rm(persistDir, { recursive: true, force: true });
});

// --- helpers -------------------------------------------------------------------------------------

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

class Cookies {
	readonly #jar = new Map<string, string>();
	take(response: Response): void {
		for (const header of response.headers.getSetCookie()) {
			const [pair] = header.split(";");
			const [name, ...value] = (pair ?? "").split("=");
			if (!name) continue;
			if (/max-age=0/i.test(header)) this.#jar.delete(name.trim());
			else this.#jar.set(name.trim(), value.join("="));
		}
	}
	header(): string {
		return [...this.#jar].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

interface Login {
	clientId: string;
	accessToken: string;
	refreshToken: string;
}

/** The whole sign-in an MCP client and its user go through: register, authorize, consent, device code, token. */
async function signIn(identity: typeof nextIdentity): Promise<Login> {
	nextIdentity = identity;
	approve = false;
	const registration = await fetch(`${base}/oauth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "Test Client <script>",
			redirect_uris: [REDIRECT_URI],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		}),
	});
	assert.equal(registration.status, 201, await registration.clone().text());
	const { client_id: clientId } = (await registration.json()) as { client_id: string };

	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const authorize = new URL(`${base}/authorize`);
	for (const [name, value] of Object.entries({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		state: "client-state",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${base}/mcp`,
		scope: "images",
	})) {
		authorize.searchParams.set(name, value);
	}
	const cookies = new Cookies();
	const consent = await fetch(authorize, { redirect: "manual" });
	assert.equal(consent.status, 200, await consent.clone().text());
	cookies.take(consent);
	const consentHtml = await consent.text();
	assert.match(consentHtml, /Test Client &#60;script&#62;/, "client name is escaped");
	assert.doesNotMatch(consentHtml, /<script>/);
	const handle = /name="handle" value="([^"]+)"/.exec(consentHtml)?.[1];
	assert.ok(handle);

	const approved = await fetch(`${base}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies.header() },
		body: new URLSearchParams({ handle, decision: "approve" }),
	});
	assert.equal(approved.status, 303, await approved.clone().text());
	assert.equal(approved.headers.get("Location"), `${base}/authorize/device`);
	cookies.take(approved);

	const devicePage = await fetch(`${base}/authorize/device`, { headers: { Cookie: cookies.header() } });
	assert.match(await devicePage.text(), /ABCD-1234/);

	// Another browser (no cookie) cannot see or finish this sign-in.
	const stranger = await fetch(`${base}/authorize/device`, { method: "POST", headers: { Accept: "application/json" } });
	assert.equal(((await stranger.json()) as { status: string }).status, "error");

	const poll = () =>
		fetch(`${base}/authorize/device`, {
			method: "POST",
			headers: { Accept: "application/json", Cookie: cookies.header(), Origin: base },
		});
	assert.deepEqual(await (await poll()).json(), { status: "pending" });
	approve = true;
	const done = await poll();
	const body = (await done.json()) as { status: string; redirectTo: string };
	assert.equal(body.status, "complete");
	const redirect = new URL(body.redirectTo);
	assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URI);
	assert.equal(redirect.searchParams.get("state"), "client-state");
	assert.equal(redirect.searchParams.get("iss"), base);
	const code = redirect.searchParams.get("code");
	assert.ok(code);

	const token = await fetch(`${base}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: clientId,
			code_verifier: verifier,
			resource: `${base}/mcp`,
		}),
	});
	assert.equal(token.status, 200, await token.clone().text());
	const tokens = (await token.json()) as { access_token: string; refresh_token: string; scope: string };
	assert.equal(tokens.scope, "images");
	return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

let requestId = 0;

/** One 2026-07-28 request: self-describing, no session, no handshake. */
async function rpc(
	token: string,
	method: string,
	params: Record<string, unknown> = {},
	options: { tasks?: boolean; name?: string } = {},
): Promise<{ status: number; result?: any; error?: any; notifications: any[] }> {
	const meta = {
		"io.modelcontextprotocol/protocolVersion": PROTOCOL,
		"io.modelcontextprotocol/clientInfo": { name: "remote-test", version: "0" },
		"io.modelcontextprotocol/clientCapabilities": options.tasks === false ? {} : { extensions: { [TASKS]: {} } },
		...((params._meta as Record<string, unknown>) ?? {}),
	};
	const name = options.name ?? (typeof params.name === "string" ? params.name : typeof params.taskId === "string" ? params.taskId : undefined);
	const response = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": PROTOCOL,
			"Mcp-Method": method,
			...(name ? { "Mcp-Name": name } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params: { ...params, _meta: meta } }),
	});
	const text = await response.text();
	if (!(response.headers.get("Content-Type") ?? "").match(/json|event-stream/)) return { status: response.status, notifications: [] };
	const messages = (response.headers.get("Content-Type") ?? "").includes("text/event-stream")
		? text
				.split("\n")
				.filter(line => line.startsWith("data:"))
				.map(line => JSON.parse(line.slice(5)))
		: [JSON.parse(text)];
	const final = messages.find(message => "id" in message && ("result" in message || "error" in message));
	return {
		status: response.status,
		result: final?.result,
		error: final?.error,
		notifications: messages.filter(message => !("id" in message)),
	};
}

async function waitForTask(token: string, taskId: string): Promise<any> {
	for (let i = 0; i < 60; i++) {
		const { result, error } = await rpc(token, "tasks/get", { taskId });
		assert.equal(error, undefined, JSON.stringify(error));
		if (result.status !== "working") return result;
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error("task did not finish");
}

// --- tests ---------------------------------------------------------------------------------------

let first: Login;
let second: Login;
let firstTaskId = "";

test("remote: advertises OAuth protected resource and authorization server metadata", { skip: !enabled }, async () => {
	const unauthenticated = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
	assert.equal(unauthenticated.status, 401);
	assert.match(unauthenticated.headers.get("WWW-Authenticate") ?? "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);

	const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
	assert.equal(resource.resource, `${base}/mcp`);
	assert.deepEqual(resource.authorization_servers, [base]);
	assert.deepEqual(resource.scopes_supported, ["images"]);

	const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
	assert.equal(server.authorization_endpoint, `${base}/authorize`);
	assert.equal(server.registration_endpoint, `${base}/oauth/register`);
	assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
	assert.equal(server.authorization_response_iss_parameter_supported, true);
});

test("remote: a user signs in with ChatGPT through consent and the device code", { skip: !enabled }, async () => {
	first = await signIn({ email: "first@example.com", userId: "user-first", accountId: "acct-first", expiresIn: 60 });
	const status = await rpc(first.accessToken, "tools/call", { name: "auth_status", arguments: {} });
	assert.match(status.result.content[0].text, /Signed in as first@example\.com on the plus plan/);
});

test("remote: server/discover and tools/list speak the stateless protocol and offer tasks", { skip: !enabled }, async () => {
	const discover = await rpc(first.accessToken, "server/discover");
	assert.deepEqual(discover.result.supportedVersions, [PROTOCOL]);
	assert.deepEqual(discover.result.capabilities.extensions, { [TASKS]: {} });
	assert.equal(discover.result._meta["io.modelcontextprotocol/serverInfo"].name, "oai-image");

	const list = await rpc(first.accessToken, "tools/list");
	assert.deepEqual(
		list.result.tools.map((tool: { name: string }) => tool.name),
		["generate_image", "edit_image", "get_image_job", "auth_status", "sign_out"],
	);
});

test("remote: generate_image returns a task, and tasks/get delivers the image", { skip: !enabled }, async () => {
	const tokenCallsBefore = issuer.to("/oauth/token").length;
	const created = await rpc(first.accessToken, "tools/call", {
		name: "generate_image",
		arguments: { prompt: "a lighthouse at dusk", size: "landscape" },
	});
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	assert.equal(created.result.resultType, "task");
	assert.equal(created.result.status, "working");
	assert.match(created.result.taskId, /^[A-Za-z0-9_-]{32}$/);
	firstTaskId = created.result.taskId;

	// The 60-second ChatGPT access token was refreshed before rendering.
	const refreshes = issuer.to("/oauth/token").slice(tokenCallsBefore).filter(request => request.json?.grant_type === "refresh_token");
	assert.equal(refreshes.length, 1);

	const done = await waitForTask(first.accessToken, firstTaskId);
	assert.equal(done.status, "completed");
	assert.equal(done.resultType, "complete");
	const result = done.result;
	assert.notEqual(result.isError, true, JSON.stringify(result));
	assert.match(result.content[0].text, /Generated 1 image/);
	const link = result.content.find((block: { type: string }) => block.type === "resource_link");
	const inline = result.content.find((block: { type: string }) => block.type === "image");
	assert.equal(inline.data, pngBytes(1536, 1024).toString("base64"));
	assert.equal(result.structuredContent.images[0].width, 1536);

	const download = await fetch(link.uri);
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("Content-Type"), "image/png");
	assert.deepEqual(Buffer.from(await download.arrayBuffer()), pngBytes(1536, 1024));

	const tampered = new URL(link.uri);
	tampered.searchParams.set("exp", String(Number(tampered.searchParams.get("exp")) + 60));
	assert.equal((await fetch(tampered)).status, 404);

	const backendRequest = backend.to("/images/generations").at(-1)!;
	assert.match(String(backendRequest.headers.authorization), /^Bearer /);
	assert.equal(backendRequest.headers["chatgpt-account-id"], "acct-first");
});

test("remote: users are isolated from each other's logins and tasks", { skip: !enabled }, async () => {
	second = await signIn({ email: "second@example.com", userId: "user-second", accountId: "acct-second", expiresIn: 3600 });
	const status = await rpc(second.accessToken, "tools/call", { name: "auth_status", arguments: {} });
	assert.match(status.result.content[0].text, /second@example\.com/);

	const stolen = await rpc(second.accessToken, "tasks/get", { taskId: firstTaskId });
	assert.equal(stolen.error?.code, -32602);
	const job = await rpc(second.accessToken, "tools/call", { name: "get_image_job", arguments: { job_id: firstTaskId, wait_seconds: 0 } });
	assert.equal(job.result.isError, true);

	renderDelayMs = 200;
	const created = await rpc(second.accessToken, "tools/call", { name: "generate_image", arguments: { prompt: "a fox" } });
	await waitForTask(second.accessToken, created.result.taskId);
	assert.equal(backend.to("/images/generations").at(-1)!.headers["chatgpt-account-id"], "acct-second");
});

test("remote: clients without tasks wait for the result, with progress", { skip: !enabled }, async () => {
	renderDelayMs = 3500;
	const call = await rpc(
		first.accessToken,
		"tools/call",
		{ name: "generate_image", arguments: { prompt: "a quick sketch" }, _meta: { progressToken: "p1" } },
		{ tasks: false },
	);
	assert.equal(call.result.resultType, "complete");
	assert.match(call.result.content[0].text, /Generated 1 image/);
	assert.ok(call.notifications.some(message => message.method === "notifications/progress"));

	const denied = await rpc(first.accessToken, "tasks/get", { taskId: firstTaskId }, { tasks: false });
	assert.equal(denied.error?.code, -32021);
});

test("remote: run_in_background returns a job id that get_image_job resolves", { skip: !enabled }, async () => {
	renderDelayMs = 1000;
	const started = await rpc(
		first.accessToken,
		"tools/call",
		{ name: "generate_image", arguments: { prompt: "a boat", run_in_background: true } },
		{ tasks: false },
	);
	const jobId = started.result.structuredContent.job_id;
	assert.ok(jobId);
	const fetched = await rpc(first.accessToken, "tools/call", { name: "get_image_job", arguments: { job_id: jobId, wait_seconds: 30 } }, { tasks: false });
	assert.match(fetched.result.content[0].text, /Generated 1 image/);
});

test("remote: tasks/cancel stops a render", { skip: !enabled }, async () => {
	renderDelayMs = 5000;
	const created = await rpc(first.accessToken, "tools/call", { name: "generate_image", arguments: { prompt: "slow" } });
	const cancel = await rpc(first.accessToken, "tasks/cancel", { taskId: created.result.taskId });
	assert.equal(cancel.result.resultType, "complete");
	const after = await rpc(first.accessToken, "tasks/get", { taskId: created.result.taskId });
	assert.equal(after.result.status, "cancelled");
	const unknown = await rpc(first.accessToken, "tasks/cancel", { taskId: "nope" });
	assert.equal(unknown.error?.code, -32602);
});

test("remote: rejects local file paths as input images", { skip: !enabled }, async () => {
	const call = await rpc(first.accessToken, "tools/call", { name: "edit_image", arguments: { prompt: "x", images: ["/etc/passwd"] } });
	const failed = call.error ?? (call.result?.isError ? call.result : undefined);
	assert.ok(failed, JSON.stringify(call));
});

test("remote: a 2025-era client is served statelessly", { skip: !enabled }, async () => {
	renderDelayMs = 200;
	const client = new Client({ name: "legacy", version: "0" });
	const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
		requestInit: { headers: { Authorization: `Bearer ${first.accessToken}` } },
	});
	await client.connect(transport);
	const { tools } = await client.listTools();
	assert.ok(tools.some(tool => tool.name === "generate_image"));
	const result = await client.callTool({ name: "generate_image", arguments: { prompt: "legacy" } });
	assert.notEqual(result.isError, true, JSON.stringify(result));
	const content = result.content as Array<{ type: string; text?: string }>;
	assert.match(content[0]!.text ?? "", /Generated 1 image/);
	await client.close();
});

test("remote: sign_out revokes the ChatGPT login and ends the connection", { skip: !enabled }, async () => {
	const revokesBefore = issuer.to("/oauth/revoke").length;
	const out = await rpc(second.accessToken, "tools/call", { name: "sign_out", arguments: {} });
	assert.match(out.result.content[0].text, /Signed out/);
	assert.equal(issuer.to("/oauth/revoke").length, revokesBefore + 1);
	const afterwards = await rpc(second.accessToken, "tools/list");
	assert.equal(afterwards.status, 401);
	// The other user is unaffected.
	const still = await rpc(first.accessToken, "tools/call", { name: "auth_status", arguments: {} });
	assert.match(still.result.content[0].text, /first@example\.com/);
});

async function refreshMcp(login: Login): Promise<Response> {
	return fetch(`${base}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: login.refreshToken,
			client_id: login.clientId,
			resource: `${base}/mcp`,
		}),
	});
}

test("remote: refreshing the MCP token keeps the ChatGPT sign-in fresh", { skip: !enabled }, async () => {
	const third = await signIn({ email: "third@example.com", userId: "user-third", accountId: "acct-third", expiresIn: 60 });
	const before = issuer.to("/oauth/token").filter(request => request.json?.grant_type === "refresh_token").length;
	const refreshed = await refreshMcp(third);
	assert.equal(refreshed.status, 200, await refreshed.clone().text());
	const tokens = (await refreshed.json()) as { access_token: string; refresh_token: string };
	assert.equal(issuer.to("/oauth/token").filter(request => request.json?.grant_type === "refresh_token").length, before + 1);
	const status = await rpc(tokens.access_token, "tools/call", { name: "auth_status", arguments: {} });
	assert.match(status.result.content[0].text, /third@example\.com/);

	// When OpenAI ends the sign-in for good, the grant ends too, so the client signs in again.
	const fourth = await signIn({ email: "fourth@example.com", userId: "user-fourth", accountId: "acct-fourth", expiresIn: 60 });
	refreshFails = true;
	try {
		const rejected = await refreshMcp(fourth);
		assert.equal(rejected.status, 400);
		assert.equal(((await rejected.json()) as { error: string }).error, "invalid_grant");
	} finally {
		refreshFails = false;
	}
});

test("remote: unknown image links are 404", { skip: !enabled }, async () => {
	assert.equal((await fetch(`${base}/images/img/AAAAAAAAAAAAAAAAAAAAAAAA/1.png?exp=9999999999&sig=x`)).status, 404);
	assert.equal((await fetch(`${base}/images/../../etc/passwd`)).status, 404);
});


