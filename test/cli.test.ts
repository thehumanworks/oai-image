import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { FileTokenStore } from "../src/auth/store.ts";
import { PACKAGE_VERSION } from "../src/constants.ts";
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
	TEST_BINARY,
	tempDir,
} from "./helpers.ts";

/** A process that outlives this is treated as hung rather than left to stall the run. */
const SPAWN_TIMEOUT_MS = 30_000;

let issuer: MockServer;
let backend: MockServer;
let respond: (request: RecordedRequest) => Reply;
let home: string;
let work: string;

before(async () => {
	home = await tempDir("oai-image-home-");
	work = await tempDir("oai-image-work-");
	issuer = await mockServer(request => {
		const route = request.path.split("?")[0];
		if (route === "/api/accounts/deviceauth/usercode") {
			return { json: { device_auth_id: "dev-1", user_code: "WXYZ-9876", interval: "1" } };
		}
		if (route === "/api/accounts/deviceauth/token") {
			return { json: { authorization_code: "code", code_challenge: "c", code_verifier: "v" } };
		}
		if (route === "/oauth/token") {
			return { json: { id_token: idToken("cli@example.com"), access_token: accessToken(), refresh_token: "refresh-cli" } };
		}
		if (route === "/oauth/revoke") return { json: {} };
		return { status: 404, text: "not found" };
	});
	backend = await mockServer(request => respond(request));
});

after(async () => {
	await issuer.close();
	await backend.close();
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(work, { recursive: true, force: true });
});

interface RunResult {
	code: number | null;
	stdout: string;
	stdoutBytes: Buffer;
	stderr: string;
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		OAI_IMAGE_HOME: path.join(home, "state"),
		OAI_IMAGE_ISSUER: issuer.url,
		OAI_IMAGE_BASE_URL: `${backend.url}/backend-api/codex`,
		NODE_NO_WARNINGS: "1",
		...extra,
	};
}

function run(args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
	backend.requests.length = 0;
	return new Promise((resolve, reject) => {
		const { command, args: argv } = cliCommand(args);
		const child = spawn(command, argv, { cwd: work, env: childEnv(options.env), stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`oai-image ${args.join(" ")} did not exit within ${SPAWN_TIMEOUT_MS / 1000}s\n${Buffer.concat(err)}`));
		}, SPAWN_TIMEOUT_MS);
		child.stdout.on("data", chunk => out.push(chunk));
		child.stderr.on("data", chunk => err.push(chunk));
		child.on("error", error => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", code => {
			clearTimeout(timer);
			const stdoutBytes = Buffer.concat(out);
			resolve({ code, stdout: stdoutBytes.toString("utf8"), stdoutBytes, stderr: Buffer.concat(err).toString("utf8") });
		});
		child.stdin.end(options.input ?? "");
	});
}

test("cli: help, version and usage errors", async () => {
	respond = () => ({ json: imageResponse() });
	const help = await run(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /oai-image generate <prompt>/);

	assert.equal((await run(["--version"])).stdout.trim(), PACKAGE_VERSION);

	const bare = await run([]);
	assert.equal(bare.code, 2);

	const unknownFlag = await run(["generate", "x", "--bogus"]);
	assert.equal(unknownFlag.code, 2);
	assert.match(unknownFlag.stderr, /Unknown option '--bogus'/);

	const unknownCommand = await run(["paint", "x"]);
	assert.equal(unknownCommand.code, 2);
	assert.match(unknownCommand.stderr, /Unknown command "paint"/);

	const badCount = await run(["generate", "x", "-n", "two"]);
	assert.equal(badCount.code, 2);
	assert.match(badCount.stderr, /--count expects a whole number/);

	const editWithoutImage = await run(["edit", "make it blue"]);
	assert.equal(editWithoutImage.code, 2);
	assert.match(editWithoutImage.stderr, /at least one input image/);
	assert.equal(backend.requests.length, 0);
});

test("cli: signed out, then device login, status, generate, edit, logout", async () => {
	respond = () => ({ json: imageResponse([pngBytes(1536, 1024)]) });

	const signedOut = await run(["status"]);
	assert.equal(signedOut.code, 3);
	assert.match(signedOut.stdout, /Not signed in/);

	const refused = await run(["generate", "a fox"]);
	assert.equal(refused.code, 3);
	assert.match(refused.stderr, /Not signed in\. Run `oai-image login`/);
	assert.equal(backend.requests.length, 0);

	const login = await run(["login", "--device"]);
	assert.equal(login.code, 0, login.stderr);
	assert.match(login.stderr, new RegExp(`Open\\s+${issuer.url}/codex/device`));
	assert.match(login.stderr, /Enter WXYZ-9876/);
	assert.match(login.stderr, /Signed in as cli@example\.com \(plus plan\)/);
	const authFile = path.join(home, "state", "auth.json");
	assert.equal((await fs.stat(authFile)).mode & 0o777, 0o600);
	assert.equal((await new FileTokenStore(authFile).load())?.refreshToken, "refresh-cli");

	const status = await run(["status", "--json"]);
	assert.equal(status.code, 0);
	const info = JSON.parse(status.stdout);
	assert.equal(info.loggedIn, true);
	assert.equal(info.email, "cli@example.com");
	assert.equal(info.planType, "plus");
	assert.equal(info.location, authFile);
	// Tokens never appear in status output.
	assert.doesNotMatch(status.stdout, /refresh-cli/);

	const generated = await run(["generate", "a", "red", "fox", "--size", "landscape", "-q", "high", "-Q"]);
	assert.equal(generated.code, 0, generated.stderr);
	const [file] = generated.stdout.trim().split("\n");
	assert.match(path.basename(file!), /^oai-image-\d{8}-\d{6}-a-red-fox\.png$/);
	assert.equal(path.dirname(file!), await fs.realpath(work));
	assert.deepEqual(await fs.readFile(file!), pngBytes(1536, 1024));
	assert.deepEqual(backend.requests[0]!.json, {
		prompt: "a red fox\n\nOutput format: landscape image, 3:2 aspect ratio.",
		background: "opaque",
		model: "gpt-image-2.6-sunburst",
		quality: "high",
		size: "1536x1024",
	});
	// Names the runtime that really ran, so a binary run cannot pass on the source by mistake.
	assert.match(backend.requests[0]!.headers["user-agent"]!, TEST_BINARY ? / bun\/\d/ : / node\/\d/);

	const input = path.join(work, "source.png");
	await fs.writeFile(input, pngBytes(256, 256));
	const edited = await run(
		["edit", "add a hat", "-i", input, "-o", "out/hat", "--transparent", "--json", "--extra", "moderation=low", "--extra", "seed=7"],
	);
	assert.equal(edited.code, 0, edited.stderr);
	const described = JSON.parse(edited.stdout);
	assert.equal(described.operation, "edit");
	assert.equal(described.model, "gpt-image-2.6-sunburst");
	assert.equal(described.images[0].path, path.join(await fs.realpath(work), "out", "hat.png"));
	assert.equal(described.images[0].width, 1536);
	const editRequest = backend.requests.at(0)!;
	const sent: Record<string, any> = editRequest.json;
	assert.equal(editRequest.path, "/backend-api/codex/images/edits");
	assert.equal(sent.images.length, 1);
	assert.equal(sent.background, "transparent");
	assert.equal(sent.moderation, "low");
	assert.equal(sent.seed, 7);

	// The same explicit path again must not be clobbered without --force.
	const clobber = await run(["generate", "again", "-o", "out/hat.png"]);
	assert.equal(clobber.code, 1);
	assert.match(clobber.stderr, /already exists/);
	assert.equal((await run(["generate", "again", "-o", "out/hat.png", "--force", "-Q"])).code, 0);

	const logout = await run(["logout"]);
	assert.equal(logout.code, 0);
	assert.match(logout.stderr, /Signed out/);
	await assert.rejects(fs.stat(authFile));
	assert.equal(issuer.to("/oauth/revoke").length, 1);
	assert.equal((await run(["status"])).code, 3);
});

test("cli: prompt from stdin, image to stdout, model from the environment, access token from the environment", async () => {
	respond = () => ({ json: imageResponse() });
	const env = { OAI_IMAGE_ACCESS_TOKEN: accessToken({ accountId: "acct-env" }), OAI_IMAGE_MODEL: "flare" };
	const result = await run(["generate", "-o", "-", "-Q"], { input: "a paper boat\n", env });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.stdoutBytes, pngBytes());
	assert.equal(backend.requests[0]!.json.prompt, "a paper boat");
	assert.equal(backend.requests[0]!.json.model, "gpt-image-2.6-flare");
	assert.equal(backend.requests[0]!.headers["chatgpt-account-id"], "acct-env");

	const status = await run(["status"], { env });
	assert.equal(status.code, 0);
	assert.match(status.stdout, /OAI_IMAGE_ACCESS_TOKEN/);
});

test("cli: a multi-megabyte image reaches stdout and disk intact", async () => {
	// Far larger than a pipe buffer, like a real generation.
	const image = largePng(3 * 1024 * 1024 + 4321);
	respond = () => ({ json: imageResponse([image]) });
	const env = { OAI_IMAGE_ACCESS_TOKEN: accessToken() };
	const piped = await run(["generate", "big", "-o", "-"], { env });
	assert.equal(piped.code, 0, piped.stderr);
	assert.equal(piped.stdoutBytes.length, image.length);
	assert.ok(piped.stdoutBytes.equals(image));

	const saved = await run(["generate", "big", "-Q", "-o", "big.png"], { env });
	assert.equal(saved.code, 0, saved.stderr);
	assert.ok((await fs.readFile(path.join(work, "big.png"))).equals(image));
});

test("cli: backend failures map to exit codes and readable messages", async () => {
	const env = { OAI_IMAGE_ACCESS_TOKEN: accessToken() };
	respond = () => ({ status: 429, json: { error: { type: "usage_limit_reached", plan_type: "plus", resets_at: 1_800_000_000 } } });
	const limited = await run(["generate", "x"], { env });
	assert.equal(limited.code, 4);
	assert.match(limited.stderr, /usage limit reached \(plus plan\)/);

	respond = () => ({ status: 400, json: { detail: "GIF output is not enabled for this request." } });
	const rejected = await run(["generate", "x", "--gif"], { env });
	assert.equal(rejected.code, 1);
	assert.match(rejected.stderr, /oai-image: Image request failed \(HTTP 400\): GIF output is not enabled for this request\./);
	assert.equal(backend.requests[0]!.json.output_format, "gif");

	respond = () => ({ status: 401, json: { detail: "Unauthorized" } });
	const unauthorized = await run(["generate", "x"], { env });
	assert.equal(unauthorized.code, 3);

	respond = () => ({ json: imageResponse([pngBytes(1024, 1024)]) });
	const warned = await run(["generate", "x", "--size", "1024x1536", "-Q"], { env });
	assert.equal(warned.code, 0);
	assert.match(warned.stderr, /warning: Requested a portrait image, 1024x1536, but got 1024x1024 \(1:1\)\./);

	// --strict-size turns a missed size into a failure; the image is still saved.
	respond = () => ({ json: imageResponse([pngBytes(1820, 864)]) });
	const strict = await run(["generate", "x", "--aspect", "21:9", "--strict-size", "--json"], { env });
	assert.equal(strict.code, 6, strict.stderr);
	assert.match(strict.stderr, /warning: Requested 21:9 \(2\.33:1\) but got 1820x864 \(2\.11:1\)\./);
	const described = JSON.parse(strict.stdout) as { sizing: Record<string, unknown>; warnings: Array<{ code: string }> };
	assert.deepEqual(described.warnings.map(warning => warning.code), ["ratio_snapped"]);
	assert.deepEqual(described.sizing.sent, { size: "1904x816", kind: "ratio", hint: "Output format: landscape image, 21:9 aspect ratio." });

	// A block page from the edge: retried once, then a retryable failure with its own exit code.
	backend.requests.length = 0;
	respond = () => ({ status: 403, text: "<!DOCTYPE html><title>Just a moment...</title>", headers: { "cf-ray": "abc-IAD" } });
	const blocked = await run(["generate", "x"], { env: { ...env } });
	assert.equal(blocked.code, 5, blocked.stderr);
	assert.match(blocked.stderr, /edge protection .*\(cf-ray abc-IAD\).*Retry in about 30s\./);
	assert.equal(backend.requests.length, 2);
});

test("cli: --codex-auth reads and refreshes the Codex CLI's auth.json in place", async () => {
	respond = () => ({ json: imageResponse() });
	const codexHome = path.join(home, "codex");
	await fs.mkdir(codexHome, { recursive: true });
	const codexFile = path.join(codexHome, "auth.json");
	await fs.writeFile(
		codexFile,
		JSON.stringify({
			auth_mode: "chatgpt",
			OPENAI_API_KEY: null,
			tokens: {
				id_token: idToken("codex@example.com"),
				access_token: accessToken({ expiresInSeconds: 10, nonce: "codex-old" }),
				refresh_token: "codex-refresh",
				account_id: "acct-123",
				login_owner_id: "owner-7",
			},
			last_refresh: "2026-11-01T00:00:00Z",
		}),
	);
	const env = { CODEX_HOME: codexHome };

	const status = await run(["status", "--codex-auth"], { env });
	assert.equal(status.code, 0);
	assert.match(status.stdout, /codex@example\.com/);

	issuer.requests.length = 0;
	const generated = await run(["generate", "x", "-Q", "--codex-auth"], { env });
	assert.equal(generated.code, 0, generated.stderr);
	// The token was about to expire, so it was refreshed and written back for Codex to find.
	assert.deepEqual(issuer.to("/oauth/token")[0]!.json.refresh_token, "codex-refresh");
	const document = JSON.parse(await fs.readFile(codexFile, "utf8"));
	assert.equal(document.tokens.refresh_token, "refresh-cli");
	assert.equal(document.tokens.login_owner_id, "owner-7");
	assert.equal(document.OPENAI_API_KEY, null);
	assert.equal(backend.requests[0]!.headers.authorization, `Bearer ${document.tokens.access_token}`);

	// Signing in or out of Codex's login is Codex's job.
	const login = await run(["login", "--codex-auth"], { env });
	assert.equal(login.code, 2);
	assert.match(login.stderr, /codex login/);
	const logout = await run(["logout", "--codex-auth"], { env });
	assert.equal(logout.code, 1);
	assert.match(logout.stderr, /codex logout/);
	assert.ok(await fs.stat(codexFile));
});

test("cli: models lists ids and aliases", async () => {
	const listed = await run(["models"]);
	assert.equal(listed.code, 0);
	assert.match(listed.stdout, /gpt-image-2\.6-sunburst\s+\(default\)/);
	assert.match(listed.stdout, /gpt-image-2\.6\s+-> gpt-image-2\.6-sunburst/);
	const json = JSON.parse((await run(["models", "--json"])).stdout);
	assert.equal(json.default, "gpt-image-2.6-sunburst");
});

test("cli: browser login completes through the loopback callback", async () => {
	const { command, args } = cliCommand(["login", "--no-browser"]);
	const child = spawn(command, args, { cwd: work, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	const timer = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT_MS);
	const exited = new Promise<number | null>(resolve => child.on("close", resolve));
	try {
		// The CLI prints the authorize URL once its callback server is listening.
		const authUrl = await new Promise<URL>((resolve, reject) => {
			child.stderr.on("data", chunk => {
				stderr += chunk;
				const match = /^\s+(http\S+\/oauth\/authorize\?\S+)$/m.exec(stderr);
				if (match) resolve(new URL(match[1]!));
			});
			child.on("close", () => reject(new Error(`login exited before printing a link:\n${stderr}`)));
		});
		assert.equal(authUrl.origin, issuer.url);
		const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
		assert.equal(redirect.hostname, "127.0.0.1");
		assert.equal(redirect.pathname, "/auth/callback");

		// Stand in for the browser coming back from the sign-in page.
		redirect.searchParams.set("code", "browser-code");
		redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
		const page = await fetch(redirect);
		assert.equal(page.status, 200);
		await page.text();

		assert.equal(await exited, 0, stderr);
		assert.match(stderr, /Signed in as cli@example\.com/);
		const exchange = issuer.to("/oauth/token").at(-1)!;
		assert.equal(exchange.form.get("code"), "browser-code");
		assert.equal(exchange.form.get("redirect_uri"), `${redirect.origin}/auth/callback`);
		assert.equal(exchange.form.get("code_verifier")!.length > 42, true);
		assert.equal((await run(["status"])).code, 0);
	} finally {
		clearTimeout(timer);
		child.kill();
		await run(["logout"]).catch(() => undefined);
	}
});

test("cli: a .env file in the working directory is not loaded", async () => {
	respond = () => ({ json: imageResponse() });
	// Bun-compiled executables load `.env` from the working directory unless built
	// not to. That would let any project's `.env` set OAI_IMAGE_BASE_URL and
	// receive the login token. The model variable stands in for it here, because
	// this test already has to set the URLs in the real environment.
	const envFile = path.join(work, ".env");
	await fs.writeFile(envFile, "OAI_IMAGE_MODEL=from-dotenv\n");
	try {
		const result = await run(["generate", "a fox", "-Q", "-o", "dotenv.png"], {
			env: { OAI_IMAGE_ACCESS_TOKEN: accessToken() },
		});
		assert.equal(result.code, 0, result.stderr);
		assert.equal(backend.requests[0]!.json.model, "gpt-image-2.6-sunburst");
	} finally {
		await fs.rm(envFile, { force: true });
	}
});
