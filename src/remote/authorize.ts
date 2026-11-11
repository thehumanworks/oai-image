import {
	type AuthRequest,
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { pollDeviceCode, requestDeviceCode } from "../auth/device-login.ts";
import { readIdentity } from "../auth/jwt.ts";
import { DEVICE_LOGIN_TIMEOUT_MS } from "../constants.ts";
import { LoginError } from "../errors.ts";
import { base64url, newKeyMaterial, randomToken, type Sealed, seal, sha256, unseal } from "./crypto.ts";
import { type Env, type GrantProps, publicOrigin, SCOPE, vaultStub } from "./env.ts";

/**
 * The authorization endpoint: consent, then "Sign in with ChatGPT".
 *
 * ChatGPT's OAuth client only accepts loopback redirect URIs, so a hosted
 * server cannot use the browser redirect flow. It uses the device-code flow
 * instead: the server asks OpenAI for a one-time code, shows it to the user,
 * and polls until they approve it on auth.openai.com.
 *
 * The pending sign-in (the client's authorization request and the device
 * code) is kept in KV, encrypted with a key derived from a random secret that
 * lives only in an HttpOnly cookie, so only the browser that gave consent can
 * finish it.
 */

const DEVICE_COOKIE = "__Host-oai-image-device";
const PENDING_TTL_SECONDS = Math.floor(DEVICE_LOGIN_TIMEOUT_MS / 1000);

interface PendingLogin {
	request: AuthRequest;
	deviceAuthId: string;
	userCode: string;
	verificationUrl: string;
	intervalMs: number;
	expiresAt: number;
	clientName: string;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	const path = new URL(request.url).pathname;
	try {
		if (path === "/authorize" && request.method === "GET") return await showConsent(request, env);
		if (path === "/authorize" && request.method === "POST") return await submitConsent(request, env);
		if (path === "/authorize/device" && request.method === "GET") return await showDevicePage(request, env);
		if (path === "/authorize/device" && request.method === "POST") return await pollDevice(request, env);
		return new Response("Method not allowed", { status: 405 });
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError) return page("Can't continue", `<p>${escape(error.description)}</p>`, 400);
		if (error instanceof CimdFetchError) {
			return page("Can't continue", "<p>This app could not be verified: its client metadata document could not be read.</p>", 400);
		}
		throw error;
	}
}

async function showConsent(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	const response = page("Connect to ChatGPT image generation", consentBody(details, consent.handle));
	for (const [name, value] of consent.headers) response.headers.append(name, value);
	return response;
}

async function submitConsent(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
	const details = await oauth.describeConsent(approved.request);
	const code = await requestDeviceCode(issuerConfig(env));
	const secret = randomToken(32);
	const pending: PendingLogin = {
		request: approved.request,
		deviceAuthId: code.deviceAuthId,
		userCode: code.userCode,
		verificationUrl: code.verificationUrl,
		intervalMs: code.intervalMs,
		expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
		clientName: details.clientName,
	};
	await savePending(env, secret, pending);
	const headers = new Headers(approved.headers);
	headers.set("Location", `${publicOrigin(env, request)}/authorize/device`);
	headers.append("Set-Cookie", `${DEVICE_COOKIE}=${secret}; Path=/; Max-Age=${PENDING_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
	headers.set("Cache-Control", "no-store");
	return new Response(null, { status: 303, headers });
}

async function showDevicePage(request: Request, env: Env): Promise<Response> {
	const loaded = await loadPending(request, env);
	if (!loaded) return expiredPage();
	const { pending } = loaded;
	return page(
		"Sign in with ChatGPT",
		`<p>To let <strong>${escape(pending.clientName)}</strong> make images with your ChatGPT plan, approve this sign-in at OpenAI.</p>
<ol>
  <li>Open <a href="${escape(pending.verificationUrl)}" target="_blank" rel="noopener noreferrer">${escape(pending.verificationUrl)}</a> and sign in to ChatGPT.</li>
  <li>Enter this code:</li>
</ol>
<p class="code" aria-label="Sign-in code">${escape(pending.userCode)}</p>
<p class="muted">Only enter a code you got from this page yourself. Never enter a code someone sent you: it would give them use of your ChatGPT plan.</p>
<p class="muted">If OpenAI says device sign-in is turned off, turn on device code sign-in for Codex in ChatGPT's security settings and try again.</p>
<form method="post" id="continue">
  <p id="status" role="status">Waiting for you to approve… this page continues on its own.</p>
  <button type="submit">I've approved it</button>
</form>
<script>
(() => {
  const status = document.getElementById("status");
  const poll = async () => {
    try {
      const response = await fetch("/authorize/device", { method: "POST", headers: { Accept: "application/json" } });
      const body = await response.json();
      if (body.status === "complete") { status.textContent = "Signed in. Returning to your app…"; location.href = body.redirectTo; return; }
      if (body.status === "error") { status.textContent = body.message; return; }
    } catch {}
    setTimeout(poll, ${Math.max(2000, pending.intervalMs)});
  };
  setTimeout(poll, ${Math.max(2000, pending.intervalMs)});
})();
</script>`,
	);
}

/** One poll of the device code. JSON for the page's script; a redirect or the page again for the plain form. */
async function pollDevice(request: Request, env: Env): Promise<Response> {
	const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
	const reply = (status: "pending" | "complete" | "error", extra: Record<string, string> = {}) =>
		Response.json({ status, ...extra }, { headers: { "Cache-Control": "no-store" } });

	const origin = request.headers.get("Origin");
	if (origin && origin !== publicOrigin(env, request)) return new Response("Forbidden", { status: 403 });

	const loaded = await loadPending(request, env);
	if (!loaded) return wantsJson ? reply("error", { message: "This sign-in expired. Start again from your app." }) : expiredPage();
	const { pending, secret } = loaded;

	let tokens: Awaited<ReturnType<typeof pollDeviceCode>>;
	try {
		tokens = await pollDeviceCode(pending, issuerConfig(env));
	} catch (error) {
		await deletePending(env, secret);
		const message = error instanceof LoginError ? `Sign-in failed: ${error.message}` : "Sign-in failed.";
		return wantsJson ? reply("error", { message }) : page("Sign-in failed", `<p>${escape(message)}</p>`, 400);
	}
	if (!tokens) {
		if (wantsJson) return reply("pending");
		return Response.redirect(`${publicOrigin(env, request)}/authorize/device`, 303);
	}

	// Approved. Each grant gets its own vault and key; the key exists only in the grant's encrypted props.
	const identity = readIdentity(tokens.accessToken, tokens.idToken);
	const vaultId = randomToken(16);
	const vaultKey = newKeyMaterial();
	await vaultStub(env, vaultId).saveLogin(vaultId, vaultKey, tokens);
	const props: GrantProps = { vaultId, vaultKey, email: identity.email, planType: identity.planType };
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: pending.request,
		userId: await userIdFor(identity.userId ?? identity.email ?? vaultId, identity.accountId),
		metadata: {},
		scope: pending.request.scope.length > 0 ? pending.request.scope : [SCOPE],
		props,
	});
	await deletePending(env, secret);
	const clear = `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
	if (wantsJson) {
		const response = reply("complete", { redirectTo });
		response.headers.append("Set-Cookie", clear);
		return response;
	}
	return new Response(null, { status: 303, headers: { Location: redirectTo, "Set-Cookie": clear, "Cache-Control": "no-store" } });
}

/** Grants are filed under an opaque id rather than the user's email or ChatGPT id. */
async function userIdFor(user: string, accountId: string | undefined): Promise<string> {
	return `u_${base64url((await sha256(`oai-image/user/${user}/${accountId ?? ""}`)).subarray(0, 18))}`;
}

function issuerConfig(env: Env) {
	return env.OAI_IMAGE_ISSUER ? { issuer: env.OAI_IMAGE_ISSUER } : {};
}

// --- pending sign-ins ------------------------------------------------------------------------

async function pendingKeys(secret: string): Promise<{ id: string; key: string }> {
	const [id, key] = await Promise.all([sha256(`oai-image/pending/id/${secret}`), sha256(`oai-image/pending/key/${secret}`)]);
	return { id: `pending:${base64url(id)}`, key: base64url(key) };
}

async function savePending(env: Env, secret: string, pending: PendingLogin): Promise<void> {
	const { id, key } = await pendingKeys(secret);
	const sealed = await seal(key, JSON.stringify(pending), id);
	await env.OAUTH_KV.put(id, JSON.stringify(sealed), { expirationTtl: PENDING_TTL_SECONDS });
}

async function loadPending(request: Request, env: Env): Promise<{ pending: PendingLogin; secret: string } | undefined> {
	const secret = readCookie(request, DEVICE_COOKIE);
	if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
	const { id, key } = await pendingKeys(secret);
	const stored = await env.OAUTH_KV.get(id);
	if (!stored) return undefined;
	try {
		const pending = JSON.parse(await unseal(key, JSON.parse(stored) as Sealed, id)) as PendingLogin;
		return pending.expiresAt > Date.now() ? { pending, secret } : undefined;
	} catch {
		return undefined;
	}
}

async function deletePending(env: Env, secret: string): Promise<void> {
	await env.OAUTH_KV.delete((await pendingKeys(secret)).id);
}

function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

// --- pages -----------------------------------------------------------------------------------

function consentBody(details: ConsentDescription, handle: string): string {
	const name = escape(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escape(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	return `<p><strong>${name}</strong> wants to generate and edit images with your ChatGPT account.</p>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p class=\"warn\"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<ul>
  <li>Images count against your ChatGPT plan's usage limits.</li>
  <li>Your ChatGPT sign-in is stored encrypted, and only this connection can unlock it. Nobody else using this server can use it.</li>
  <li>You can sign out at any time with the <code>sign_out</code> tool, which also revokes the sign-in at OpenAI.</li>
</ul>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Continue to ChatGPT sign-in</button> <button name="decision" value="deny" class="secondary">Cancel</button></p>
</form>`;
}

function expiredPage(): Response {
	return page("Sign-in expired", "<p>This sign-in expired or was opened in another browser. Start connecting again from your app.</p>", 400);
}

export function page(title: string, body: string, status = 200): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --card: #fff; --muted: #6e6e73; --accent: #10a37f; --border: #e3e3e6; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f2f2f2; --bg: #111; --card: #1c1c1e; --muted: #a1a1a6; --border: #333; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 34rem; margin: 3rem auto; padding: 1.5rem; background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  h1 { font-size: 1.35rem; margin-top: 0; }
  .code { font: 600 2rem/1.2 ui-monospace, monospace; letter-spacing: .15em; text-align: center; padding: .75rem; border: 1px dashed var(--border); border-radius: 8px; }
  .muted { color: var(--muted); font-size: .9rem; }
  .warn { padding: .5rem .75rem; border-left: 3px solid #d97706; }
  button { font: inherit; padding: .55rem 1rem; border-radius: 8px; border: 0; background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  a { color: var(--accent); }
  @media (max-width: 36rem) { main { margin: 0; border-radius: 0; border-width: 0 0 1px; } }
</style>
</head>
<body><main><h1>${escape(title)}</h1>${body}</main></body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
		},
	});
}

export function escape(value: string): string {
	return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}
