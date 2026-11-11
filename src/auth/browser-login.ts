import { spawn } from "node:child_process";
import * as http from "node:http";
import { LOGIN_CALLBACK_PATH, LOGIN_FALLBACK_PORT, LOGIN_PORT } from "../constants.ts";
import { LoginError } from "../errors.ts";
import { buildAuthorizeUrl, describe, exchangeCodeForTokens, type OAuthConfig, resolveOAuthConfig } from "./oauth.ts";
import { generatePkce, generateState } from "./pkce.ts";
import type { StoredTokens } from "./store.ts";

export interface BrowserLoginOptions extends OAuthConfig {
	/**
	 * Loopback port for the callback. Defaults to 1455, then 1457 if that is
	 * busy. The issuer only accepts the ports registered for the Codex client,
	 * so other values work only against a custom issuer.
	 */
	port?: number;
	/** Give up after this long. Default 10 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface BrowserLogin {
	/** Open this in a browser to sign in. */
	readonly authUrl: string;
	readonly redirectUri: string;
	readonly port: number;
	/** Resolves with tokens once the browser returns to the callback. */
	wait(): Promise<StoredTokens>;
	cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Start the browser sign-in: an authorization-code flow with PKCE whose
 * callback lands on a short-lived server bound to 127.0.0.1.
 */
export async function startBrowserLogin(options: BrowserLoginOptions = {}): Promise<BrowserLogin> {
	const config = resolveOAuthConfig(options);
	const pkce = generatePkce();
	const state = generateState();

	const server = http.createServer();
	const port = await listen(server, options.port);
	const redirectUri = `http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}`;
	const authUrl = buildAuthorizeUrl(config, { redirectUri, challenge: pkce.challenge, state });

	let settled = false;
	let exchanging = false;
	let resolveTokens!: (tokens: StoredTokens) => void;
	let rejectTokens!: (error: Error) => void;
	const result = new Promise<StoredTokens>((resolve, reject) => {
		resolveTokens = resolve;
		rejectTokens = reject;
	});
	// The caller may attach `wait()` late; an early failure must not crash the process.
	result.catch(() => undefined);

	const shutdown = () => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		server.close();
		server.closeAllConnections();
	};
	const finish = (outcome: StoredTokens | Error) => {
		if (settled) return;
		settled = true;
		// Let the final response flush before the sockets are torn down.
		setTimeout(shutdown, 50).unref();
		if (outcome instanceof Error) rejectTokens(outcome);
		else resolveTokens(outcome);
	};
	const onAbort = () => finish(new LoginError("Login cancelled", "cancelled"));
	const timer = setTimeout(
		() => finish(new LoginError("Timed out waiting for the browser sign-in to finish", "timeout")),
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	timer.unref();
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });

	server.on("request", (request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		const send = (status: number, title: string, message: string) => {
			response.writeHead(status, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "close",
			});
			response.end(page(title, message));
		};

		if (url.pathname === "/cancel") {
			send(200, "Sign-in cancelled", "You can close this tab.");
			finish(new LoginError("Login cancelled", "cancelled"));
			return;
		}
		if (url.pathname !== LOGIN_CALLBACK_PATH) {
			send(404, "Not found", "This address only handles the sign-in callback.");
			return;
		}
		if (settled || exchanging) {
			send(409, "Sign-in already finished", "You can close this tab.");
			return;
		}
		// A request with the wrong state did not come from this sign-in; ignore it and keep waiting.
		if (url.searchParams.get("state") !== state) {
			send(400, "Sign-in failed", "State mismatch. Start the sign-in again from your terminal.");
			return;
		}
		const errorCode = url.searchParams.get("error");
		if (errorCode) {
			const message = callbackErrorMessage(errorCode, url.searchParams.get("error_description"));
			send(400, "Sign-in failed", message);
			finish(new LoginError(message, errorCode));
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			send(400, "Sign-in failed", "The callback carried no authorization code.");
			finish(new LoginError("The sign-in callback carried no authorization code", "missing_code"));
			return;
		}
		// Claim the callback now: an authorization code is single-use, so a
		// duplicate request must not start a second exchange.
		exchanging = true;
		exchangeCodeForTokens(config, { code, verifier: pkce.verifier, redirectUri, signal: options.signal }).then(
			tokens => {
				send(200, "Signed in", "oai-image is now signed in with ChatGPT. You can close this tab.");
				finish(tokens);
			},
			(error: unknown) => {
				const failure = error instanceof Error ? error : new LoginError(describe(error));
				send(500, "Sign-in failed", failure.message);
				finish(failure);
			},
		);
	});

	return {
		authUrl,
		redirectUri,
		port,
		wait: () => result,
		cancel: () => finish(new LoginError("Login cancelled", "cancelled")),
	};
}

/** Try to open `url` in the user's browser. Returns false when no opener could be started. */
export function openInBrowser(url: string): Promise<boolean> {
	const [command, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	return new Promise(resolve => {
		try {
			const child = spawn(command, args, { stdio: "ignore", detached: true });
			child.once("error", () => resolve(false));
			child.once("spawn", () => {
				child.unref();
				resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}

async function listen(server: http.Server, requested?: number): Promise<number> {
	const candidates = requested === undefined ? [LOGIN_PORT, LOGIN_FALLBACK_PORT] : [requested];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				server.once("error", onError);
				server.listen(candidate, "127.0.0.1", () => {
					server.off("error", onError);
					resolve();
				});
			});
			const address = server.address();
			if (address && typeof address === "object") return address.port;
			throw new LoginError("Could not determine the login callback port");
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
		}
	}
	if ((lastError as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
		throw new LoginError(
			`Port ${candidates.join(" and ")} on 127.0.0.1 ${candidates.length > 1 ? "are" : "is"} already in use, ` +
				"so the browser sign-in cannot receive its callback. Close the program using it " +
				"(another login in progress?) or use the device-code login instead (`oai-image login --device`).",
			"port_in_use",
		);
	}
	throw new LoginError(`Could not start the login callback server: ${describe(lastError)}`, "listen_failed");
}

function callbackErrorMessage(code: string, description: string | null): string {
	if (code === "access_denied" && description?.toLowerCase().includes("missing_codex_entitlement")) {
		return "This ChatGPT account or workspace does not have Codex access. Ask your workspace admin to enable it.";
	}
	const detail = description?.trim();
	return detail ? `Sign-in failed: ${detail} (${code})` : `Sign-in failed: ${code}`;
}

function page(title: string, message: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f6f4; color: #1a1a1a; }
main { max-width: 32rem; padding: 2rem; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { margin: 0; color: #555; }
@media (prefers-color-scheme: dark) { body { background: #161616; color: #f2f2f2; } p { color: #aaa; } }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>
`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}
