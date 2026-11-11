# oai-image

Generate and edit images with OpenAI's image models using your **ChatGPT subscription** instead of an API key. One package, three ways in:

- a **CLI** (`oai-image generate "a red fox"`),
- a TypeScript **SDK** (`new OaiImage().generate(...)`),
- an **MCP server** (`oai-image mcp`) for Claude Code, Codex, Cursor and other MCP clients.

It signs in with "Sign in with ChatGPT", the same OAuth flow the [Codex CLI](https://github.com/openai/codex) uses, and calls the same image endpoints Codex calls (`chatgpt.com/backend-api/codex/images/generations` and `/images/edits`).

> **Unofficial.** This is not an OpenAI product. It reuses the Codex CLI's public OAuth client, and every image counts against your ChatGPT plan's Codex usage limits (OpenAI says image generation uses them 3–5x faster than a normal turn). Image generation is not included in the Free plan.

## Read this first: which model you actually get

You can ask for any model id, and the default is `gpt-image-2.6-sunburst`. Whether you *get* it is up to OpenAI's backend, and today the evidence says you do not:

- OpenAI documents GPT Image 2.6 as two API models, `gpt-image-2.6-sunburst` (detail) and `gpt-image-2.6-flare` (speed). There is no bare `gpt-image-2.6` id; this package accepts it as an alias for Sunburst.
- The Codex CLI itself still sends `gpt-image-2` on this route, and OpenAI's Codex docs say built-in image generation uses `gpt-image-2`.
- Users who probed the ChatGPT-login route report that it **ignores the `model` field** and runs its own model (`gpt-image-2-codex`) whatever you send, that it does not honour `size`, and that it rejects GIF output ([openai/codex#59890](https://github.com/openai/codex/issues/59890), [#43965](https://github.com/openai/codex/issues/43965)).
- The response does not say which model ran, so this package cannot tell you. `result.model` is the id that was *requested*.

So: requesting a 2.6 model is harmless and will start working if OpenAI wires model selection up, but do not assume 2.6 output today. If you need a specific model guaranteed, use the OpenAI API with an API key.

**Not yet verified with a real login.** This package was built from the Codex CLI source and tested against local mocks of the sign-in service and the backend. Two things were checked against the real services, neither needing an account: the sign-in service issues a device code for this package's request, and the image endpoint exists and answers this package's request shape with a clean 401 for a made-up token. A signed-in generation has not been run from this codebase yet.

## Install

Requires Node.js 20.11 or newer.

```sh
git clone <this repo> && cd oai-image
npm install        # also builds dist/
npm link           # puts `oai-image` and `oai-image-mcp` on your PATH
```

### Nix

The repo is a flake. It builds the Node package (on `nodejs_24`), runs the test suite during the build, and installs both `oai-image` and `oai-image-mcp`.

Try it without installing:

```sh
nix run github:thehumanworks/oai-image -- login
nix run github:thehumanworks/oai-image#mcp     # the MCP server on stdio
```

Add it as an input to your flake:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    oai-image.url = "github:thehumanworks/oai-image";
    oai-image.inputs.nixpkgs.follows = "nixpkgs";
  };
}
```

Then use the package wherever you list packages, for example in Home Manager, NixOS or a dev shell:

```nix
home.packages = [ inputs.oai-image.packages.${pkgs.stdenv.hostPlatform.system}.default ];
# environment.systemPackages = [ ... ];        NixOS
# devShells.default = pkgs.mkShell { packages = [ ... ]; };
```

Or apply the overlay and refer to `pkgs.oai-image`:

```nix
nixpkgs.overlays = [ inputs.oai-image.overlays.default ];
home.packages = [ pkgs.oai-image ];
```

Or use the Home Manager module:

```nix
imports = [ inputs.oai-image.homeManagerModules.default ];
programs.oai-image.enable = true;
```

Once installed, register the MCP server as shown in [MCP server](#mcp-server); `oai-image mcp` and `oai-image-mcp` are both on your `PATH`. If your MCP client does not inherit your shell's `PATH`, point it at the store path instead, e.g. `"${pkgs.oai-image}/bin/oai-image-mcp"`.

The Nix build leaves out the `bun` dev dependency, so `npm run build:binary` is not part of it. Use `nix develop` for a shell with Node 24 and Bun. After changing `package-lock.json`, update `npmDepsHash` in `nix/package.nix` (set it to an empty string, run `nix build`, and copy the hash from the error).

### Standalone binary

To run it without Node.js, compile the CLI into a single executable with [Bun](https://bun.sh). The MCP server is inside the same file.

```sh
npm install
npm run build:binary                              # this machine -> dist-bin/oai-image
node scripts/build-binary.mjs --all               # every target below
node scripts/build-binary.mjs darwin-arm64 windows-x64
```

Targets: `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl` (Alpine), `darwin-arm64`, `darwin-x64`, `windows-x64`. Named targets are written as `dist-bin/oai-image-<target>`. Each file is 85 to 110 MB, almost all of it the Bun runtime. Copy it anywhere on your `PATH`:

```sh
install -m 755 dist-bin/oai-image ~/.local/bin/oai-image
oai-image login
```

The binary behaves like the Node CLI: same commands, same `~/.oai-image/auth.json`, same environment variables. It is built not to read `.env` or `bunfig.toml` from the working directory (Bun executables do by default), so a project's `.env` cannot redirect where your login token is sent. Its `User-Agent` says `bun/<version>` instead of `node/<version>`.

Only the `linux-x64` binary has been run: `npm run test:binary` drives sign-in, generation, editing and the MCP server through it against local mocks. The other targets compile here but are untested.

## CLI

```sh
oai-image login                 # opens your browser
oai-image login --device        # no browser on this machine (SSH, containers)
oai-image status

oai-image generate "a lighthouse at dusk, oil painting"
oai-image generate "app icon of a paper boat" --size square --transparent -o icon.png
oai-image generate "wide establishing shot of a desert city" --aspect 16:9 --quality high -n 2
oai-image edit "make it night, keep the composition" -i photo.jpg
oai-image generate "the product from image 1 in the style of image 2" -i product.png -i style.png

echo "a prompt from a pipe" | oai-image generate -o - > out.png
```

Saved file paths are printed to stdout, one per line; progress and warnings go to stderr. Auto-named files look like `oai-image-20261110-090507-a-lighthouse-at-dusk.png` and never overwrite anything. `--output` refuses to overwrite unless you pass `--force`.

| Option | Meaning |
| --- | --- |
| `-o, --output <file>` | Save to this file. `-` writes the image to stdout. |
| `-d, --out-dir <dir>` | Directory for auto-named files. Default: current directory, or `OAI_IMAGE_OUTPUT_DIR`. |
| `-m, --model <id>` | Model id or alias. Default `gpt-image-2.6-sunburst`, or `OAI_IMAGE_MODEL`. |
| `-s, --size <size>` | `auto`, `WIDTHxHEIGHT`, `square`, `landscape`, `portrait`, `2k`, `4k`. |
| `-a, --aspect <w:h>` | Aspect ratio such as `16:9`, instead of `--size`. |
| `-q, --quality <level>` | `auto`, `low`, `medium`, `high`. |
| `-b, --background <kind>` | `opaque` (default), `transparent`, `auto`. `--transparent` is a shortcut. |
| `-n, --count <n>` | Number of images, 1–10. |
| `-i, --image <file>` | Input image; repeat for several. Turns `generate` into an edit. |
| `--gif`, `--frames`, `--frame-ms` | Ask for an animated GIF (reported as not enabled on ChatGPT logins). |
| `--no-size-hint` | Do not also state the requested size in the prompt (see below). |
| `--extra key=value` | Extra request field, e.g. `--extra moderation=low`. Value is parsed as JSON when possible. |
| `--json` | Print a JSON description of the result instead of paths. |
| `--timeout <s>`, `--retries <n>` | Default 600 seconds and 0 retries. Under Node.js the built-in fetch gives up after 300 seconds without a response, whatever `--timeout` says; the standalone binary waits the full time. |
| `--codex-auth` | Use the Codex CLI's login instead of this package's own. |

Exit codes: `0` success, `1` failure, `2` bad usage, `3` not signed in, `4` plan usage limit reached.

Run `oai-image models` for the known model ids and aliases.

### About sizes

OpenAI's [Codex image guide](https://learn.chatgpt.com/docs/image-generation) says to describe framing and dimensions in the prompt, and users report the backend disregards the `size` field. So a requested size or aspect ratio is sent both ways: in `size`, and as a sentence appended to the prompt (`Output format: landscape image, 16:9 aspect ratio.`). Whether the sentence is enough to get the canvas you asked for has not been measured on this route. Turn it off with `--no-size-hint` (`sizeHint: false` in the SDK). The actual dimensions are read from the returned image, and you get a warning if they differ from what you asked for.

### About backgrounds

The default is `opaque`, because that is what Codex sends unless transparency is requested. `transparent` is the other value Codex sends. `auto` is a documented Images API value but has not been tried on this route.

## SDK

```ts
import { OaiImage, saveImages } from "oai-image";

const client = new OaiImage();           // uses the saved `oai-image login`

const result = await client.generate({
  prompt: "a lighthouse at dusk, oil painting",
  aspectRatio: "16:9",
  quality: "high",
});

const [saved] = await saveImages(result.images, { dir: "out", nameHint: result.prompt });
console.log(saved.path, result.images[0].width, result.images[0].height, result.warnings);

// Editing: paths, data URLs, bytes, or { fileId }
const edited = await client.edit({
  prompt: "remove the background",
  images: ["./product.png"],
  background: "transparent",
});
await edited.images[0].save("product-cutout.png");
```

Each `GeneratedImage` has `bytes`, `base64`, `mimeType`, `extension`, `width`, `height`, `toDataUrl()` and `save(file)`. The result also carries `warnings`, `usage`, the request ids, and `raw` (the response minus image data).

Signing in from code:

```ts
import { AuthManager, openInBrowser } from "oai-image";

const auth = new AuthManager();
const login = await auth.startBrowserLogin();   // or auth.startDeviceLogin()
await openInBrowser(login.authUrl);
await login.wait();                             // tokens are saved when this resolves
```

Bring your own credentials by passing `auth`: `new StaticTokenAuth(accessToken)` for a fixed token, `new AuthManager({ store })` with your own `TokenStore` (keychain, secret manager), or any object with a `getAuth()` method.

Errors are typed: `AuthRequiredError` (sign in again), `UsageLimitError` (with `resetsAt`), `ApiError` (with `status`, `code`, `requestId`), `ValidationError`, `ResponseError`, `LoginError`. All extend `OaiImageError`. Backend error messages are passed through verbatim.

Nothing is retried unless you set `maxRetries`, because a failed call may still have used quota. The one exception is a single refresh-and-retry when the backend answers 401.

## MCP server

```sh
oai-image mcp          # stdio; `oai-image-mcp` is the same thing
```

Claude Code:

```sh
claude mcp add oai-image -- oai-image mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.oai-image]
command = "oai-image"
args = ["mcp"]
```

With the standalone binary, give its path instead: `claude mcp add oai-image -- /path/to/oai-image mcp`. There is no separate `oai-image-mcp` binary.

Any client that takes JSON:

```json
{ "mcpServers": { "oai-image": { "command": "oai-image", "args": ["mcp"] } } }
```

Tools:

| Tool | What it does |
| --- | --- |
| `generate_image` | Text to image. Optional `reference_images`, `size`, `aspect_ratio`, `quality`, `background`, `n`, `model`, `output_dir`, `filename`, `return_image`. |
| `edit_image` | Edit or combine existing `images` according to a prompt. Same options. |
| `auth_status` | Who is signed in, or how to sign in. |
| `login` | Starts a device-code (default) or browser sign-in and returns the link and code for the user. |

Images are written to disk and the path is returned, along with the image inline when it is under 3 MiB (`OAI_IMAGE_MCP_INLINE_MAX_BYTES`, `0` to never inline). That cap keeps the base64 under the 5 MB per-image limit of the strictest Claude platform; it has not been tried against a real client with full-size images, so lower it if your client rejects large tool results. Files go to `output_dir`, else `OAI_IMAGE_OUTPUT_DIR`, else `./generated_images`, else `~/oai-image` when the working directory is not writable. Existing files are never overwritten. Progress notifications are sent while an image renders, since that often takes longer than a client's default tool timeout.

Sign in once with `oai-image login` in a terminal before using the server, or let the model call `login` and follow the link it gives you.

## Where your login lives

- `~/.oai-image/auth.json`, mode `0600` (`OAI_IMAGE_HOME` moves the directory). The layout matches Codex's `auth.json`.
- Access tokens are refreshed automatically five minutes before they expire. Refresh tokens are single-use, so refreshes are serialized across processes with a lock file; the CLI and the MCP server can safely run at once.
- `oai-image logout` deletes the file and revokes the refresh token.
- **Reusing the Codex CLI's login:** pass `--codex-auth` or set `OAI_IMAGE_USE_CODEX_AUTH=1` to read `~/.codex/auth.json` (`$CODEX_HOME`) instead. Refreshed tokens are written back to that same file, preserving its other fields, so Codex finds the new ones. This is opt-in because it modifies another tool's file, and because the lock only coordinates oai-image processes: if Codex and oai-image refresh at the same instant, one of them can end up with a dead refresh token and you will need to run `codex login` again. It does not work if Codex keeps its credentials in the OS keyring.
- `OAI_IMAGE_ACCESS_TOKEN` (with optional `OAI_IMAGE_ACCOUNT_ID`) supplies a fixed access token that is never refreshed.

Do not copy a refresh token between tools. Whichever tool refreshes first invalidates the other's copy.

## How it works

1. **Sign in.** Authorization-code flow with PKCE against `auth.openai.com`, using the Codex CLI's client id, with the callback on `http://127.0.0.1:1455/auth/callback` (falling back to port 1457, the only other port registered). The device-code flow uses `auth.openai.com/api/accounts/deviceauth/*` and needs no local port.
2. **Call.** `POST https://chatgpt.com/backend-api/codex/images/generations` (or `/images/edits`) with a JSON body: `prompt`, `model`, `size`, `quality`, `background`, optional `n`, and for edits `images: [{ "image_url": "data:..." }]`. Headers: the bearer token, `chatgpt-account-id` from the token's claims, `originator: oai-image`, and a `version` header as Codex sends. The default body is the one Codex sends, except for the model id (`gpt-image-2.6-sunburst` instead of `gpt-image-2`).
3. **Read.** The response is `{ data: [{ b64_json }], size, quality, background, usage }`. The format and dimensions are detected from the image bytes.

`originator` and `User-Agent` identify this tool honestly rather than posing as Codex; override them with `OAI_IMAGE_ORIGINATOR` or the `originator` / `userAgent` options if you need to.

## Development

```sh
npm run typecheck
npm test            # node --test, against local mock servers; no network, no credentials
npm run build
npm run check       # all three
npm run test:binary # builds dist-bin/oai-image, then runs the CLI and MCP tests against it
```

Tests run the TypeScript sources directly (Node 22.18+ or 24), so no build is needed first. `OAI_IMAGE_ISSUER` and `OAI_IMAGE_BASE_URL` point the CLI at other endpoints.

## License

MIT
