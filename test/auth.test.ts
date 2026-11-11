import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { startBrowserLogin } from "../src/auth/browser-login.ts";
import { startDeviceLogin } from "../src/auth/device-login.ts";
import { AuthManager, StaticTokenAuth } from "../src/auth/manager.ts";
import { FileTokenStore, MemoryTokenStore, type StoredTokens } from "../src/auth/store.ts";
import { CODEX_CLIENT_ID } from "../src/constants.ts";
import { AuthRequiredError, LoginError, OaiImageError } from "../src/errors.ts";
import { accessToken, idToken, type MockServer, mockServer, type Reply, tempDir } from "./helpers.ts";

/** A mock of auth.openai.com whose behaviour each test scripts through `issuer.script`. */
const script: {
	token?: (request: { json: any; form: URLSearchParams }) => Reply;
	devicePolls: number;
	pendingPolls: number;
} = { devicePolls: 0, pendingPolls: 0 };
let issuer: MockServer;
let dir: string;

before(async () => {
	dir = await tempDir();
	issuer = await mockServer(request => {
		const route = request.path.split("?")[0];
		if (route === "/oauth/token") {
			if (script.token) return script.token(request);
			return { json: { id_token: idToken(), access_token: accessToken(), refresh_token: "refresh-1" } };
		}
		if (route === "/api/accounts/deviceauth/usercode") {
			return { json: { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" } };
		}
		if (route === "/api/accounts/deviceauth/token") {
			script.devicePolls += 1;
			if (script.devicePolls <= script.pendingPolls) return { status: 403, json: { error: "authorization_pending" } };
			return { json: { authorization_code: "device-code", code_challenge: "challenge", code_verifier: "device-verifier" } };
		}
		if (route === "/oauth/revoke") return { json: {} };
		return { status: 404, text: "not found" };
	});
});

after(async () => {
	await issuer.close();
	await fs.rm(dir, { recursive: true, force: true });
});

function reset() {
	issuer.requests.length = 0;
	script.token = undefined;
	script.devicePolls = 0;
	script.pendingPolls = 0;
}

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
	return { accessToken: accessToken(), refreshToken: "refresh-0", idToken: idToken(), accountId: "acct-123", ...overrides };
}

test("browser login: authorize URL, callback, and code exchange match Codex", async () => {
	reset();
	const login = await startBrowserLogin({ issuer: issuer.url, port: 0, originator: "oai-image" });
	const url = new URL(login.authUrl);
	assert.equal(`${url.origin}${url.pathname}`, `${issuer.url}/oauth/authorize`);
	assert.equal(login.redirectUri, `http://127.0.0.1:${login.port}/auth/callback`);
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		response_type: "code",
		client_id: CODEX_CLIENT_ID,
		redirect_uri: login.redirectUri,
		scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
		code_challenge: url.searchParams.get("code_challenge"),
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "oai-image",
		state: url.searchParams.get("state"),
	});

	// A callback with the wrong state is refused and does not end the login.
	const forged = await fetch(`${login.redirectUri}?code=evil&state=wrong`);
	assert.equal(forged.status, 400);
	assert.equal(issuer.to("/oauth/token").length, 0);

	const callback = await fetch(`${login.redirectUri}?code=auth-code&state=${url.searchParams.get("state")}`);
	assert.equal(callback.status, 200);
	assert.match(await callback.text(), /Signed in/);
	const result = await login.wait();
	assert.equal(result.refreshToken, "refresh-1");
	assert.equal(result.accountId, "acct-123");

	const [exchange] = issuer.to("/oauth/token");
	assert.equal(exchange!.headers["content-type"], "application/x-www-form-urlencoded");
	assert.equal(exchange!.form.get("grant_type"), "authorization_code");
	assert.equal(exchange!.form.get("client_id"), CODEX_CLIENT_ID);
	assert.equal(exchange!.form.get("code"), "auth-code");
	assert.equal(exchange!.form.get("redirect_uri"), login.redirectUri);
	assert.ok(exchange!.form.get("code_verifier"));
});

test("browser login: an error callback rejects with the issuer's reason", async () => {
	reset();
	const login = await startBrowserLogin({ issuer: issuer.url, port: 0 });
	const state = new URL(login.authUrl).searchParams.get("state");
	const callback = await fetch(
		`${login.redirectUri}?error=access_denied&error_description=missing_codex_entitlement&state=${state}`,
	);
	assert.equal(callback.status, 400);
	await assert.rejects(login.wait(), (error: unknown) => {
		assert.ok(error instanceof LoginError);
		assert.equal(error.code, "access_denied");
		assert.match(error.message, /does not have Codex access/);
		return true;
	});
});

test("browser login: a failed token exchange is reported, and cancel and timeout reject", async () => {
	reset();
	script.token = () => ({ status: 400, json: { error: "invalid_grant", error_description: "code expired" } });
	const login = await startBrowserLogin({ issuer: issuer.url, port: 0 });
	const state = new URL(login.authUrl).searchParams.get("state");
	const callback = await fetch(`${login.redirectUri}?code=stale&state=${state}`);
	assert.equal(callback.status, 500);
	await assert.rejects(login.wait(), /Token exchange failed \(400\): invalid_grant: code expired/);

	const cancelled = await startBrowserLogin({ issuer: issuer.url, port: 0 });
	cancelled.cancel();
	await assert.rejects(cancelled.wait(), /cancelled/);

	const slow = await startBrowserLogin({ issuer: issuer.url, port: 0, timeoutMs: 20 });
	await assert.rejects(slow.wait(), /Timed out/);
});

test("browser login: a busy port fails with a pointer to the device flow", async () => {
	reset();
	const first = await startBrowserLogin({ issuer: issuer.url, port: 0 });
	await assert.rejects(startBrowserLogin({ issuer: issuer.url, port: first.port }), (error: unknown) => {
		assert.ok(error instanceof LoginError);
		assert.equal(error.code, "port_in_use");
		assert.match(error.message, /login --device/);
		return true;
	});
	first.cancel();
	await assert.rejects(first.wait());
});

test("device login: polls through pending answers, then redeems the server-side PKCE code", async () => {
	reset();
	script.pendingPolls = 2;
	const login = await startDeviceLogin({ issuer: issuer.url, pollIntervalMs: 10 });
	assert.equal(login.verificationUrl, `${issuer.url}/codex/device`);
	assert.equal(login.userCode, "ABCD-1234");
	assert.deepEqual(issuer.to("/deviceauth/usercode")[0]!.json, { client_id: CODEX_CLIENT_ID });

	const result = await login.wait();
	assert.equal(result.refreshToken, "refresh-1");
	assert.equal(issuer.to("/deviceauth/token").length, 3);
	assert.deepEqual(issuer.to("/deviceauth/token")[0]!.json, { device_auth_id: "dev-1", user_code: "ABCD-1234" });
	const exchange = issuer.to("/oauth/token")[0]!;
	assert.equal(exchange.form.get("code"), "device-code");
	assert.equal(exchange.form.get("code_verifier"), "device-verifier");
	assert.equal(exchange.form.get("redirect_uri"), `${issuer.url}/deviceauth/callback`);
});

test("device login: expires and can be cancelled", async () => {
	reset();
	script.pendingPolls = Number.POSITIVE_INFINITY;
	const expiring = await startDeviceLogin({ issuer: issuer.url, pollIntervalMs: 10, timeoutMs: 60 });
	await assert.rejects(expiring.wait(), /expired/);

	const controller = new AbortController();
	const cancelled = await startDeviceLogin({ issuer: issuer.url, pollIntervalMs: 10, signal: controller.signal });
	const waiting = cancelled.wait();
	controller.abort();
	await assert.rejects(waiting, /cancelled/);
});

test("file store: round trip, permissions, and unknown fields survive", async () => {
	const file = path.join(dir, "store", "auth.json");
	const store = new FileTokenStore(file);
	assert.equal(await store.load(), undefined);
	await store.save(tokens());
	const mode = (await fs.stat(file)).mode & 0o777;
	assert.equal(mode, 0o600);
	const loaded = await store.load();
	assert.equal(loaded?.refreshToken, "refresh-0");
	assert.equal(loaded?.accountId, "acct-123");
	assert.ok(loaded?.lastRefresh);

	// A Codex-style document with fields this package does not model.
	await fs.writeFile(
		file,
		JSON.stringify({
			auth_mode: "chatgpt",
			OPENAI_API_KEY: null,
			tokens: {
				id_token: idToken(),
				access_token: "old-access",
				refresh_token: "old-refresh",
				account_id: "acct-123",
				login_owner_id: "owner-1",
			},
			last_refresh: "2026-01-01T00:00:00Z",
			agent_identity: { keep: true },
		}),
	);
	await store.save(tokens({ accessToken: "new-access", refreshToken: "new-refresh" }));
	const document = JSON.parse(await fs.readFile(file, "utf8"));
	assert.equal(document.tokens.access_token, "new-access");
	assert.equal(document.tokens.refresh_token, "new-refresh");
	assert.equal(document.tokens.login_owner_id, "owner-1");
	assert.deepEqual(document.agent_identity, { keep: true });
	assert.equal(document.OPENAI_API_KEY, null);
	assert.notEqual(document.last_refresh, "2026-01-01T00:00:00Z");
	assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["auth.json"]);

	await store.clear();
	assert.equal(await store.load(), undefined);
});

test("file store: a shared (Codex) file cannot be cleared, and an API-key-only file is not a login", async () => {
	const file = path.join(dir, "codex", "auth.json");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
	const store = new FileTokenStore(file, { shared: true });
	assert.equal(await store.load(), undefined);
	await assert.rejects(store.clear(), /codex logout/);
	assert.ok(await fs.stat(file));

	await fs.writeFile(file, "{ not json");
	await assert.rejects(store.load(), OaiImageError);
});

test("file store: the lock serializes holders and recovers from an abandoned lock", async () => {
	const file = path.join(dir, "lock", "auth.json");
	const store = new FileTokenStore(file, { lockStaleMs: 200 });
	const other = new FileTokenStore(file, { lockStaleMs: 200 });
	const order: string[] = [];
	const hold = (name: string, target: FileTokenStore) =>
		target.withLock(async () => {
			order.push(`${name}:in`);
			await new Promise(resolve => setTimeout(resolve, 40));
			order.push(`${name}:out`);
		});
	await Promise.all([hold("a", store), hold("b", other)]);
	assert.ok(order.join(",") === "a:in,a:out,b:in,b:out" || order.join(",") === "b:in,b:out,a:in,a:out", order.join(","));

	// A crashed process left its lock behind; it is taken over once stale.
	await fs.writeFile(`${file}.lock`, "99999\n");
	const old = new Date(Date.now() - 5000);
	await fs.utimes(`${file}.lock`, old, old);
	assert.equal(await store.withLock(async () => "ok"), "ok");
	await assert.rejects(fs.stat(`${file}.lock`));
});

test("manager: a fresh token is used as is", async () => {
	reset();
	const manager = new AuthManager({ issuer: issuer.url, store: new MemoryTokenStore(tokens()) });
	const auth = await manager.getAuth();
	assert.equal(auth.accountId, "acct-123");
	assert.equal(auth.identity.email, "person@example.com");
	assert.equal(issuer.requests.length, 0);
});

test("manager: a token near expiry is refreshed with a JSON body and the rotation is saved", async () => {
	reset();
	const fresh = accessToken({ nonce: "fresh" });
	script.token = () => ({ json: { access_token: fresh, refresh_token: "refresh-2" } });
	const store = new MemoryTokenStore(tokens({ accessToken: accessToken({ expiresInSeconds: 60 }) }));
	const manager = new AuthManager({ issuer: issuer.url, store });

	const results = await Promise.all([manager.getAuth(), manager.getAuth(), manager.getAuth()]);
	assert.deepEqual(results.map(result => result.accessToken), [fresh, fresh, fresh]);
	// Three callers, one refresh: a refresh token is single-use.
	assert.equal(issuer.to("/oauth/token").length, 1);
	const request = issuer.to("/oauth/token")[0]!;
	assert.equal(request.headers["content-type"], "application/json");
	assert.deepEqual(request.json, { client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: "refresh-0" });
	const saved = await store.load();
	assert.equal(saved?.refreshToken, "refresh-2");
	// The id token was not reissued, so the old one is kept.
	assert.equal(saved?.idToken, idToken());
});

test("manager: a caller's cancellation never interrupts a refresh in flight", async () => {
	reset();
	script.token = () => ({ json: { access_token: accessToken({ nonce: "kept" }), refresh_token: "refresh-kept" } });
	const store = new MemoryTokenStore(tokens({ accessToken: accessToken({ expiresInSeconds: 1 }) }));
	const manager = new AuthManager({ issuer: issuer.url, store });
	// Were the refresh aborted after the issuer rotated the token, the login would be lost.
	await manager.getAuth({ signal: AbortSignal.abort() });
	assert.equal((await store.load())?.refreshToken, "refresh-kept");
});

test("manager: a rejected token forces a refresh, unless someone else already rotated it", async () => {
	reset();
	const current = tokens();
	const store = new MemoryTokenStore(current);
	const manager = new AuthManager({ issuer: issuer.url, store });
	const rotated = accessToken({ nonce: "rotated" });
	script.token = () => ({ json: { access_token: rotated, refresh_token: "refresh-9" } });

	const refreshed = await manager.getAuth({ rejectedAccessToken: current.accessToken });
	assert.equal(refreshed.accessToken, rotated);
	assert.equal(issuer.to("/oauth/token").length, 1);

	// The 401 was for the old token; the store already holds a newer one.
	const again = await manager.getAuth({ rejectedAccessToken: current.accessToken });
	assert.equal(again.accessToken, rotated);
	assert.equal(issuer.to("/oauth/token").length, 1);
});

test("manager: two processes sharing a file refresh once between them", async () => {
	reset();
	const file = path.join(dir, "shared", "auth.json");
	await new FileTokenStore(file).save(tokens({ accessToken: accessToken({ expiresInSeconds: 30 }) }));
	let refreshes = 0;
	script.token = request => {
		refreshes += 1;
		// A second use of the same refresh token would be fatal at the real issuer.
		if (request.json.refresh_token !== "refresh-0") return { status: 401, json: { error: { code: "refresh_token_reused" } } };
		return { json: { access_token: accessToken({ nonce: `r${refreshes}` }), refresh_token: "refresh-next" } };
	};
	const one = new AuthManager({ issuer: issuer.url, store: new FileTokenStore(file) });
	const two = new AuthManager({ issuer: issuer.url, store: new FileTokenStore(file) });
	const [a, b] = await Promise.all([one.getAuth(), two.getAuth()]);
	assert.equal(refreshes, 1);
	assert.equal(a.accessToken, b.accessToken);
	assert.equal((await new FileTokenStore(file).load())?.refreshToken, "refresh-next");
});

test("manager: dead refresh tokens ask for a new login; server trouble does not", async () => {
	const stale = () => new MemoryTokenStore(tokens({ accessToken: accessToken({ expiresInSeconds: -10 }) }));
	const cases: Array<[Reply, AuthRequiredError["reason"]]> = [
		[{ status: 401, json: { error: { code: "refresh_token_expired" } } }, "refresh-expired"],
		[{ status: 401, json: { error: { code: "refresh_token_reused" } } }, "refresh-reused"],
		[{ status: 401, json: { error: { code: "refresh_token_invalidated" } } }, "refresh-revoked"],
		[{ status: 400, json: { error: "invalid_grant" } }, "rejected"],
	];
	for (const [reply, reason] of cases) {
		reset();
		script.token = () => reply;
		const store = stale();
		const manager = new AuthManager({ issuer: issuer.url, store });
		await assert.rejects(manager.getAuth(), (error: unknown) => {
			assert.ok(error instanceof AuthRequiredError, String(error));
			assert.equal(error.reason, reason);
			assert.match(error.message, /oai-image login/);
			return true;
		});
		// The saved login is left alone for the user to inspect or replace.
		assert.ok(await store.load());
	}

	reset();
	script.token = () => ({ status: 503, text: "upstream unavailable" });
	const manager = new AuthManager({ issuer: issuer.url, store: stale() });
	await assert.rejects(manager.getAuth(), (error: unknown) => {
		assert.ok(error instanceof LoginError && !(error instanceof AuthRequiredError));
		assert.match(error.message, /503/);
		return true;
	});
});

test("manager: opaque tokens fall back to the 8-day refresh interval", async () => {
	reset();
	script.token = () => ({ json: { access_token: "opaque-2", refresh_token: "refresh-2" } });
	const recent = new AuthManager({
		issuer: issuer.url,
		store: new MemoryTokenStore({ accessToken: "opaque", refreshToken: "r", lastRefresh: new Date().toISOString() }),
	});
	assert.equal((await recent.getAuth()).accessToken, "opaque");
	const old = new AuthManager({
		issuer: issuer.url,
		store: new MemoryTokenStore({
			accessToken: "opaque",
			refreshToken: "r",
			lastRefresh: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString(),
		}),
	});
	assert.equal((await old.getAuth()).accessToken, "opaque-2");
});

test("manager: login persists, status reports, logout clears and revokes", async () => {
	reset();
	const store = new FileTokenStore(path.join(dir, "session", "auth.json"));
	const manager = new AuthManager({ issuer: issuer.url, store });
	assert.deepEqual(await manager.status(), { loggedIn: false, location: store.location });
	await assert.rejects(manager.getAuth(), AuthRequiredError);
	assert.equal(await manager.logout(), false);

	const login = await manager.startDeviceLogin({ pollIntervalMs: 10 });
	await login.wait();
	const status = await manager.status();
	assert.equal(status.loggedIn, true);
	assert.equal(status.identity?.email, "person@example.com");
	assert.equal(status.identity?.planType, "plus");
	assert.ok(status.accessTokenExpiresAt instanceof Date);

	assert.equal(await manager.logout(), true);
	assert.equal((await manager.status()).loggedIn, false);
	assert.deepEqual(issuer.to("/oauth/revoke")[0]!.json, {
		token: "refresh-1",
		token_type_hint: "refresh_token",
		client_id: CODEX_CLIENT_ID,
	});
});

test("static token auth: used as is, and a rejection cannot be recovered", async () => {
	const token = accessToken({ accountId: "acct-static" });
	const auth = new StaticTokenAuth(token);
	assert.equal((await auth.getAuth()).accountId, "acct-static");
	await assert.rejects(auth.getAuth({ rejectedAccessToken: token }), AuthRequiredError);
});
