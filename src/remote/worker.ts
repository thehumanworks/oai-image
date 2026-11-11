import { OAuthError, OAuthProvider, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../constants.ts";
import { escape, handleAuthorize, page } from "./authorize.ts";
import { type Env, type GrantProps, publicOrigin, SCOPE, vaultStub } from "./env.ts";
import { serveImage } from "./images.ts";
import { handleMcpRequest } from "./mcp.ts";

export { Vault } from "./vault.ts";

/**
 * oai-image as a remote MCP server on Cloudflare Workers.
 *
 * - `/mcp`: the MCP endpoint (streamable HTTP, 2026-07-28 stateless protocol,
 *   with stateless 2025-era fallback), behind OAuth 2.1 bearer tokens.
 * - `/authorize`: consent and "Sign in with ChatGPT".
 * - `/oauth/*`, `/.well-known/*`: the authorization server (OAuthProvider).
 * - `/images/*`: signed, expiring download links for generated images.
 */

const ONE_HOUR = 60 * 60;
/**
 * MCP refresh tokens: a grant lives as long as it is used at least once a
 * year, so users never have to sign in again while they keep using it.
 */
const ONE_YEAR = 365 * 24 * ONE_HOUR;

const mcpHandler = {
	async fetch(request: Request, env: Env, ctx: OAuthResourceContext<GrantProps>): Promise<Response> {
		if (!ctx.auth.scope.includes(SCOPE)) return new Response("Insufficient scope", { status: 403 });
		const props = ctx.props;
		// Tokens look like `{userId}:{grantId}:{secret}`.
		const [userId, grantId] = ctx.auth.token.split(":");
		return handleMcpRequest(
			request,
			env,
			{ props, userId, grantId },
			{
				token: ctx.auth.token,
				clientId: ctx.auth.clientId ?? "",
				scopes: ctx.auth.scope,
				expiresAt: ctx.auth.expiresAt,
			},
		);
	},
};

const defaultHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/authorize" || url.pathname.startsWith("/authorize/")) return handleAuthorize(request, env);
		if (url.pathname.startsWith("/images/")) return (await serveImage(request, env)) ?? notFound();
		if (url.pathname === "/" && request.method === "GET") return landing(publicOrigin(env, request));
		return notFound();
	},
};

const providers = new Map<string, OAuthProvider<Env>>();

/** The provider's resource URL is fixed at construction, so build one per public origin. */
function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpHandler as never,
			defaultHandler: defaultHandler as never,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/oauth/token",
			// Dynamic Client Registration is deprecated in MCP 2026-07-28 in favour of
			// Client ID Metadata Documents, but many clients still rely on it.
			clientRegistrationEndpoint: "/oauth/register",
			clientIdMetadataDocumentEnabled: true,
			scopesSupported: [SCOPE],
			requiredScopes: [SCOPE],
			resourceMetadata: {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				bearer_methods_supported: ["header"],
				resource_name: `${PACKAGE_NAME} (ChatGPT image generation)`,
			},
			accessTokenTTL: ONE_HOUR,
			refreshTokenTTL: ONE_YEAR,
			// Each refresh extends the grant, so an active connection never expires.
			refreshTokenIdleTTL: ONE_YEAR,
			tokenExchangeCallback: keepChatGptSignInAlive,
		});
		providers.set(origin, provider);
	}
	return provider;
}

/**
 * Each time the MCP client refreshes its token (about hourly while it is in
 * use), refresh the ChatGPT sign-in too when it is due. If OpenAI has ended
 * the sign-in for good, end the grant so the client signs in again instead of
 * failing on every call. Transient failures never block the client's refresh.
 */
async function keepChatGptSignInAlive(options: { grantType: string; props: unknown; env: Env }): Promise<void> {
	if (options.grantType !== "refresh_token") return;
	const props = options.props as GrantProps | undefined;
	if (!props?.vaultId || !props.vaultKey) return;
	const result = await vaultStub(options.env, props.vaultId)
		.keepAlive(props.vaultKey)
		.catch(() => undefined);
	if (result && !result.ok && result.code === "auth_required") {
		throw new OAuthError("invalid_grant", { description: "The ChatGPT sign-in has ended. Sign in again." });
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return providerFor(publicOrigin(env, request)).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

function landing(origin: string): Response {
	const endpoint = `${origin}/mcp`;
	return page(
		"oai-image MCP server",
		`<p>Generate and edit images with your own ChatGPT subscription from any MCP client.</p>
<p>Add this server URL to your MCP client:</p>
<p class="code" style="font-size:1rem;letter-spacing:0">${escape(endpoint)}</p>
<p>When you connect, you sign in with your ChatGPT account. Your sign-in is stored encrypted and only your connection can use it.</p>
<p class="muted">${escape(PACKAGE_NAME)} ${escape(PACKAGE_VERSION)}. Unofficial; not an OpenAI product.</p>`,
	);
}

function notFound(): Response {
	return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
