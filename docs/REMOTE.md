# Hosted MCP server (Cloudflare Workers)

`src/remote/` runs oai-image as a remote, multi-tenant MCP server. Anyone you give the URL to can connect from an MCP client, sign in with their own ChatGPT account, and generate images on their own plan. Nobody can use anyone else's sign-in.

```
https://<your-worker>.workers.dev/mcp
```

## What it speaks

- **MCP 2026-07-28**, the stateless revision: no `initialize` handshake, no `Mcp-Session-Id`, every request self-describing. Any request can land on any Worker instance. Built on the v2 TypeScript SDK (`@modelcontextprotocol/server`, `createMcpHandler`).
- **2025-era clients** (2025-11-25 and earlier) are served by the SDK's stateless fallback on the same endpoint, so today's clients work too.
- **Tasks extension** (`io.modelcontextprotocol/tasks`). When a client declares it, `generate_image` and `edit_image` answer at once with a task handle (`resultType: "task"`), and the client polls `tasks/get`; `tasks/cancel` stops a render. Rendering never blocks the request.
- **Clients without tasks** get the same work two ways: by default the call waits for the image and sends progress notifications; with `run_in_background: true` it returns a job id to fetch with `get_image_job` (the explicit-handle pattern the 2026 spec recommends for state across calls).
- **Authorization**: OAuth 2.1 per the MCP authorization spec, via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): RFC 9728 protected resource metadata, RFC 8414 server metadata, PKCE, RFC 8707 resource binding, RFC 9207 `iss`, Client ID Metadata Documents, and Dynamic Client Registration for clients that still need it.

Tools: `generate_image`, `edit_image`, `get_image_job`, `auth_status`, `sign_out`. Input images are `data:image/...;base64,` or `https://` URLs; the server cannot read local files. Results carry a download link (signed, valid 24 hours) and the image inline when it is 3 MiB or smaller.

## How signing in works

1. The MCP client discovers the authorization server from the `401` on `/mcp` and sends the user to `/authorize`.
2. A consent page names the client, its verified domain (for CIMD clients) and where access is sent, and warns about local apps. It cannot be framed or forged (browser-bound handle).
3. On approval the server asks OpenAI for a **device code** and shows it. The user opens `auth.openai.com/codex/device`, signs in to ChatGPT, and enters the code. ChatGPT's OAuth client only allows loopback redirect URIs, so a hosted server cannot use the browser-redirect flow; the device flow is the one that works.
4. The page polls; once OpenAI approves, the server stores the ChatGPT tokens and finishes the OAuth authorization back to the client.

The pending sign-in is kept in KV encrypted with a key derived from a random secret held only in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, so only the browser that gave consent can finish it, and it expires after 15 minutes.

## How credentials are isolated

```
MCP access token ──unwraps──▶ grant props { vaultId, vaultKey }   (OAuth provider, KV, encrypted per token)
                                      │
                                      ▼
                     Vault Durable Object "vaultId"
                     creds = AES-256-GCM(vaultKey, ChatGPT tokens, bound to vaultId)
                     jobs  = { status, result metadata }          images → R2 img/<job id>/
```

- Each authorization gets its **own vault** (a Durable Object) and its **own random 256-bit key**. The key is stored only in the grant's props, which the OAuth provider encrypts with a key wrapped by the grant's tokens. KV holds only hashes of tokens.
- So reading KV, Durable Object storage or R2, alone or together, does not reveal anyone's ChatGPT tokens. Using a sign-in requires a live MCP token for that grant.
- A request can only reach the vault named in its own grant. Task and job ids are 192-bit random and are looked up inside the caller's vault, so another user's task id is simply "not found" (`-32602`). There is no `tasks/list`.
- ChatGPT refresh tokens are single-use. Each vault serializes its refreshes, so concurrent calls never burn the login.
- If OpenAI rejects the refresh token (expired, revoked, reused), the vault forgets the login and the server revokes the grant, so the client signs in again instead of failing forever.
- `sign_out` revokes the refresh token at OpenAI, deletes the vault, its jobs and images, and revokes the grant.
- Housekeeping: jobs and images are deleted after 24 hours; a vault unused for 400 days is wiped.

### How long a sign-in lasts

Users sign in once. The server keeps both halves of the sign-in alive on its own:

- **ChatGPT tokens** are refreshed automatically: before any call when the access token is within 5 minutes of expiring, and at least once every 7 days while the connection is in use, so the refresh token keeps rotating and never goes stale at OpenAI.
- **The MCP connection**: access tokens last 1 hour and clients refresh them silently. Each of those refreshes also tops up the ChatGPT sign-in when it is due, so a connected client keeps it fresh even when it makes no images. The grant's refresh token lasts a year and is extended on every refresh, so a connection used at least once a year never expires.
- The sign-in ends only when the user signs out, when OpenAI ends it (password change, revoked session, "log out of all devices"), or after a year with no use. In the first two cases the server ends the grant too, and the client takes the user through sign-in again automatically.

The one gap is a client left unused for a long time: refreshes happen on use, because the server cannot unlock a ChatGPT login without that user's own token. If OpenAI expires an unused refresh token before the client comes back, that user signs in again.

Background renders run inside the vault. The ChatGPT access token they need lives only in memory for the render; nothing decryptable is written for them. If the object restarts mid-render (a deploy, a rare eviction) the job ends as "interrupted" and the user can retry.

What this does not protect against: whoever controls the Cloudflare account can change the code to capture tokens as they are used. Only deploy to an account you trust, and tell your users who runs the server.

## Deploy

You need a Cloudflare account (the free plan works; Durable Objects on the free plan use the SQLite backend this project configures) and Node 22.18+.

```sh
npm install
npx wrangler login                       # opens a browser to authorize Wrangler
npm run deploy:remote                    # creates the KV namespace and R2 bucket on first deploy
openssl rand -hex 32 | npx wrangler secret put IMAGE_URL_SECRET
```

`wrangler deploy` prints the URL, e.g. `https://oai-image.<your-subdomain>.workers.dev`. Add `<that URL>/mcp` to your MCP client.

Optional:

- **Custom domain**: add a route in `wrangler.jsonc` (`"routes": [{ "pattern": "images.example.com", "custom_domain": true }]`) and set `PUBLIC_URL` to `https://images.example.com`.
- **Backstop for image storage**: `npx wrangler r2 bucket lifecycle add oai-image-images expire-2d --expire-days 2` deletes any image the 24-hour cleanup missed.
- **Logs**: `npx wrangler tail`. Tokens, prompts and images are never logged.

## Connect a client

Claude Code:

```sh
claude mcp add --transport http oai-image https://oai-image.<your-subdomain>.workers.dev/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.oai-image]
url = "https://oai-image.<your-subdomain>.workers.dev/mcp"
```

Claude.ai, ChatGPT and other apps: add a custom connector with the same URL. The client opens the sign-in page the first time.

## Develop and test

```sh
npm run dev:remote          # wrangler dev on http://localhost:8787 (put IMAGE_URL_SECRET in .dev.vars)
npm run test:remote         # end-to-end: OAuth, device sign-in, tasks, 2025 fallback, isolation, sign-out
npm run types:remote        # regenerate src/remote/worker-configuration.d.ts after editing wrangler.jsonc
```

`test:remote` starts the Worker in workerd with `wrangler dev --env test` and points it at local mocks of OpenAI's sign-in service and image backend; it needs no network or account.

## Why Cloudflare rather than Vercel

- The OAuth side is the hard part of a multi-tenant MCP server. `workers-oauth-provider` implements the 2026-07-28 MCP authorization profile, including CIMD and RFC 9207, and encrypts per-grant props with token-wrapped keys, which is exactly the isolation this server needs. On Vercel this would be hand-built.
- Durable Objects give one strongly consistent, single-threaded home per sign-in: the natural place to serialize single-use refresh tokens and to keep a render running after the request that started it returns. On Vercel that means Redis plus a queue or workflow product.
- Image renders take up to a few minutes of waiting on OpenAI. Workers bill CPU time, not wall time spent waiting.
