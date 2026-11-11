#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { openInBrowser } from "./auth/browser-login.ts";
import { type AuthManager, defaultAuth, defaultAuthManager } from "./auth/manager.ts";
import { FileTokenStore } from "./auth/store.ts";
import { type GenerateOptions, type ImageResult, OaiImage } from "./client.ts";
import {
	CODEX_IMAGE_MODEL,
	DEFAULT_IMAGE_MODEL,
	ENV,
	KNOWN_IMAGE_MODELS,
	MODEL_ALIASES,
	PACKAGE_VERSION,
	resolveModel,
} from "./constants.ts";
import { AuthRequiredError, OaiImageError, UsageLimitError, ValidationError } from "./errors.ts";
import { type SavedImage, saveImages } from "./output.ts";

const EXIT = { ok: 0, failure: 1, usage: 2, auth: 3, limit: 4 } as const;

const HELP = `oai-image ${PACKAGE_VERSION}
Generate and edit images with OpenAI's image models through your ChatGPT subscription.

Usage
  oai-image login [--device] [--no-browser]   Sign in with ChatGPT
  oai-image logout                            Forget the saved login
  oai-image status [--json]                   Show who is signed in
  oai-image generate <prompt> [options]       Generate images
  oai-image edit <prompt> -i <image> [...]    Edit or combine images
  oai-image models                            List known image models
  oai-image mcp                               Run the MCP server on stdio

Generate and edit options
  -o, --output <file>       Save to this file ("-" writes the image to stdout)
  -d, --out-dir <dir>       Directory for auto-named files (default: current directory)
  -m, --model <id>          Image model (default: ${DEFAULT_IMAGE_MODEL})
  -s, --size <size>         auto, WIDTHxHEIGHT, square, landscape, portrait, 2k, 4k
  -a, --aspect <w:h>        Aspect ratio such as 16:9 (instead of --size)
  -q, --quality <level>     auto, low, medium, high
  -b, --background <kind>   opaque (default), transparent, auto
      --transparent         Same as --background transparent
  -n, --count <n>           Number of images (1-10)
  -i, --image <file>        Input image; repeat for several (turns generate into edit)
      --gif                 Ask for an animated GIF
      --frames <n>          GIF frame count (2-16)
      --frame-ms <ms>       GIF frame duration (20-2000)
      --no-size-hint        Do not also state the requested size in the prompt
      --extra <key=value>   Extra request field; value is parsed as JSON when possible
      --force               Overwrite the --output file if it exists
      --timeout <seconds>   Give up after this long (default: 600)
      --retries <n>         Retry network errors and 502/503/504 this many times (default: 0)
      --json                Print a JSON description of the result
  -Q, --quiet               No progress output

Global options
      --codex-auth          Use the Codex CLI's login (~/.codex/auth.json) instead of oai-image's own
  -h, --help
  -v, --version

The prompt may also be piped on stdin. Saved file paths are printed to stdout, one per line.

Environment
  ${ENV.model}            Default model
  ${ENV.outputDir}       Default output directory
  ${ENV.useCodexAuth}  Set to 1 for --codex-auth
  ${ENV.accessToken}     Use this ChatGPT access token instead of a saved login
  ${ENV.home}             Where the login is stored (default: ~/.oai-image)
`;

const OPTIONS = {
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
	"codex-auth": { type: "boolean" },
	json: { type: "boolean" },
	quiet: { type: "boolean", short: "Q" },
	device: { type: "boolean" },
	"no-browser": { type: "boolean" },
	output: { type: "string", short: "o" },
	"out-dir": { type: "string", short: "d" },
	model: { type: "string", short: "m" },
	size: { type: "string", short: "s" },
	aspect: { type: "string", short: "a" },
	quality: { type: "string", short: "q" },
	background: { type: "string", short: "b" },
	transparent: { type: "boolean" },
	count: { type: "string", short: "n" },
	image: { type: "string", short: "i", multiple: true },
	gif: { type: "boolean" },
	frames: { type: "string" },
	"frame-ms": { type: "string" },
	"no-size-hint": { type: "boolean" },
	extra: { type: "string", multiple: true },
	force: { type: "boolean" },
	timeout: { type: "string" },
	retries: { type: "string" },
} satisfies ParseArgsConfig["options"];

type Flags = ReturnType<typeof parseCli>["values"];

function parseCli(argv: string[]) {
	return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

class UsageError extends Error {}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	let parsed: ReturnType<typeof parseCli>;
	try {
		parsed = parseCli(argv);
	} catch (error) {
		process.stderr.write(`oai-image: ${(error as Error).message}\nRun \`oai-image --help\` for usage.\n`);
		return EXIT.usage;
	}
	const { values: flags, positionals } = parsed;
	const [command, ...rest] = positionals;

	if (flags.version) {
		process.stdout.write(`${PACKAGE_VERSION}\n`);
		return EXIT.ok;
	}
	if (flags.help || !command || command === "help") {
		process.stdout.write(HELP);
		return flags.help || command === "help" ? EXIT.ok : EXIT.usage;
	}

	try {
		switch (command) {
			case "login":
				return await login(flags);
			case "logout":
				return await logout(flags);
			case "status":
			case "whoami":
				return await status(flags);
			case "generate":
			case "gen":
				return await generate(flags, rest, false);
			case "edit":
				return await generate(flags, rest, true);
			case "models":
				return models(flags);
			case "mcp": {
				const { runStdioServer } = await import("./mcp.ts");
				await runStdioServer({ useCodexAuth: flags["codex-auth"] });
				return EXIT.ok;
			}
			default:
				throw new UsageError(`Unknown command "${command}"`);
		}
	} catch (error) {
		return report(error);
	}
}

function report(error: unknown): number {
	if (error instanceof UsageError || error instanceof ValidationError) {
		process.stderr.write(`oai-image: ${error.message}\nRun \`oai-image --help\` for usage.\n`);
		return EXIT.usage;
	}
	if (error instanceof AuthRequiredError) {
		process.stderr.write(`oai-image: ${error.message}\n`);
		return EXIT.auth;
	}
	if (error instanceof UsageLimitError) {
		process.stderr.write(`oai-image: ${error.message}\n`);
		return EXIT.limit;
	}
	if (error instanceof OaiImageError) {
		process.stderr.write(`oai-image: ${error.message}\n`);
		return EXIT.failure;
	}
	process.stderr.write(`oai-image: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	return EXIT.failure;
}

function manager(flags: Flags): AuthManager {
	return defaultAuthManager({ useCodexAuth: flags["codex-auth"] });
}

async function login(flags: Flags): Promise<number> {
	const auth = manager(flags);
	if (auth.store instanceof FileTokenStore && auth.store.shared) {
		throw new UsageError("With --codex-auth the login belongs to the Codex CLI. Run `codex login` instead.");
	}
	const err = process.stderr;
	if (flags.device) {
		const device = await auth.startDeviceLogin();
		err.write(
			"\nSign in with ChatGPT using a one-time code:\n\n" +
				`  1. Open  ${device.verificationUrl}\n` +
				`  2. Enter ${device.userCode}\n\n` +
				"The code expires in 15 minutes. Only continue if you started this login yourself.\n" +
				"Waiting for approval…\n",
		);
		await device.wait();
	} else {
		const browser = await auth.startBrowserLogin();
		const opened = flags["no-browser"] ? false : await openInBrowser(browser.authUrl);
		err.write(
			`\n${opened ? "Your browser should open to sign in with ChatGPT. If it does not, open this link:" : "Open this link to sign in with ChatGPT:"}\n\n` +
				`  ${browser.authUrl}\n\n` +
				`Waiting for the sign-in to finish on http://127.0.0.1:${browser.port} …\n` +
				"(On a remote machine or in a container? Press Ctrl+C and run `oai-image login --device`.)\n",
		);
		const onSigint = () => browser.cancel();
		process.once("SIGINT", onSigint);
		try {
			await browser.wait();
		} finally {
			process.off("SIGINT", onSigint);
		}
	}
	const current = await auth.status();
	const who = current.identity?.email ?? "your ChatGPT account";
	const plan = current.identity?.planType ? ` (${current.identity.planType} plan)` : "";
	err.write(`\nSigned in as ${who}${plan}. Credentials saved to ${current.location}\n`);
	return EXIT.ok;
}

async function logout(flags: Flags): Promise<number> {
	const removed = await manager(flags).logout();
	process.stderr.write(removed ? "Signed out.\n" : "Not signed in.\n");
	return EXIT.ok;
}

async function status(flags: Flags): Promise<number> {
	if (process.env[ENV.accessToken]?.trim() && !flags["codex-auth"]) {
		const auth = await defaultAuth().getAuth();
		const info = { loggedIn: true, source: `${ENV.accessToken} environment variable`, ...auth.identity };
		if (flags.json) process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
		else process.stdout.write(`Using the access token in ${ENV.accessToken}${info.email ? ` (${info.email})` : ""}.\n`);
		return EXIT.ok;
	}
	const current = await manager(flags).status();
	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					loggedIn: current.loggedIn,
					location: current.location,
					email: current.identity?.email,
					planType: current.identity?.planType,
					accountId: current.identity?.accountId,
					accessTokenExpiresAt: current.accessTokenExpiresAt?.toISOString(),
					lastRefresh: current.lastRefresh?.toISOString(),
				},
				null,
				2,
			)}\n`,
		);
		return current.loggedIn ? EXIT.ok : EXIT.auth;
	}
	if (!current.loggedIn) {
		process.stdout.write(`Not signed in. Run \`oai-image login\`.\n(Looked in ${current.location})\n`);
		return EXIT.auth;
	}
	const lines = [
		`Signed in as ${current.identity?.email ?? "(unknown email)"}`,
		`  Plan:        ${current.identity?.planType ?? "unknown"}`,
		`  Workspace:   ${current.identity?.accountId ?? "unknown"}`,
		`  Credentials: ${current.location}`,
	];
	if (current.accessTokenExpiresAt) {
		const expired = current.accessTokenExpiresAt.getTime() <= Date.now();
		lines.push(
			`  Access token ${expired ? "expired" : "expires"} ${current.accessTokenExpiresAt.toLocaleString()} (refreshed automatically)`,
		);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return EXIT.ok;
}

function models(flags: Flags): number {
	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({ default: resolveModel(), models: KNOWN_IMAGE_MODELS, aliases: MODEL_ALIASES }, null, 2)}\n`,
		);
		return EXIT.ok;
	}
	const current = resolveModel();
	const lines = ["Image model ids OpenAI documents (any other id is sent as is):", ""];
	for (const id of KNOWN_IMAGE_MODELS) lines.push(`  ${id}${id === current ? "   (default)" : ""}`);
	lines.push("", "Aliases:");
	for (const [alias, id] of Object.entries(MODEL_ALIASES)) lines.push(`  ${alias.padEnd(14)} -> ${id}`);
	lines.push(
		"",
		"Note: with a ChatGPT login the backend decides which model actually runs and does not",
		`report it. The Codex CLI itself sends "${CODEX_IMAGE_MODEL}" on this route.`,
	);
	process.stdout.write(`${lines.join("\n")}\n`);
	return EXIT.ok;
}

async function generate(flags: Flags, promptWords: string[], requireImages: boolean): Promise<number> {
	const prompt = await readPrompt(promptWords);
	const images = flags.image ?? [];
	if (requireImages && images.length === 0) {
		throw new UsageError("edit needs at least one input image (-i <file>)");
	}
	if (flags.output && flags["out-dir"]) throw new UsageError("Use either --output or --out-dir, not both");
	if (flags.transparent && flags.background && flags.background !== "transparent") {
		throw new UsageError("--transparent conflicts with --background");
	}
	const toStdout = flags.output === "-";
	const count = integer(flags.count, "--count");
	if (toStdout && (count ?? 1) > 1) throw new UsageError("--output - can only write one image");

	const frames = integer(flags.frames, "--frames");
	const frameMs = integer(flags["frame-ms"], "--frame-ms");
	const timeoutSeconds = integer(flags.timeout, "--timeout");
	const request: GenerateOptions = {
		prompt,
		model: flags.model,
		size: flags.size,
		aspectRatio: flags.aspect,
		quality: flags.quality,
		background: (flags.transparent ? "transparent" : flags.background) as GenerateOptions["background"],
		n: count,
		images,
		gif: flags.gif || frames !== undefined || frameMs !== undefined ? { frameCount: frames, frameDurationMs: frameMs } : undefined,
		sizeHint: flags["no-size-hint"] ? false : undefined,
		extraBody: parseExtra(flags.extra),
		timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
	};

	const client = new OaiImage({
		auth: defaultAuth({ useCodexAuth: flags["codex-auth"] }),
		maxRetries: integer(flags.retries, "--retries"),
	});
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	const quiet = flags.quiet || flags.json;
	const model = resolveModel(flags.model);
	const stop = quiet ? () => {} : progress(`${images.length > 0 ? "Editing" : "Generating"} with ${model}`);
	let result: ImageResult;
	try {
		result = await client.generate({ ...request, signal: controller.signal });
	} finally {
		stop();
		process.off("SIGINT", onSigint);
	}

	let saved: SavedImage[] = [];
	if (toStdout) {
		const image = result.images[0];
		if (image) await new Promise<void>(resolve => process.stdout.write(image.bytes, () => resolve()));
	} else {
		saved = await saveImages(result.images, {
			file: flags.output,
			dir: flags["out-dir"] ?? process.env[ENV.outputDir],
			nameHint: prompt,
			overwrite: flags.force,
		});
	}

	for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
	if (flags.json) {
		if (!toStdout) process.stdout.write(`${JSON.stringify(describeResult(result, saved), null, 2)}\n`);
		return EXIT.ok;
	}
	for (const { path: file, image } of saved) {
		process.stdout.write(`${file}\n`);
		if (!quiet) {
			const size = image.width && image.height ? `${image.width}x${image.height} ` : "";
			process.stderr.write(`  ${size}${image.extension.toUpperCase()}, ${formatBytes(image.byteLength)}\n`);
		}
	}
	return EXIT.ok;
}

export function describeResult(result: ImageResult, saved: readonly SavedImage[]) {
	return {
		operation: result.operation,
		model: result.model,
		reportedModel: result.reportedModel,
		prompt: result.prompt,
		size: result.size,
		quality: result.quality,
		background: result.background,
		outputFormat: result.outputFormat,
		images: result.images.map(image => ({
			path: saved.find(entry => entry.image === image)?.path,
			mimeType: image.mimeType,
			width: image.width,
			height: image.height,
			bytes: image.byteLength,
			generationId: image.generationId,
		})),
		usage: result.usage,
		requestId: result.requestId,
		imagegenRequestId: result.imagegenRequestId,
		warnings: result.warnings,
		responseHeaders: result.responseHeaders,
	};
}

async function readPrompt(words: string[]): Promise<string> {
	const inline = words.join(" ").trim();
	if (inline && inline !== "-") return inline;
	if (process.stdin.isTTY) throw new UsageError("A prompt is required");
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const piped = Buffer.concat(chunks).toString("utf8").trim();
	if (!piped) throw new UsageError("A prompt is required");
	return piped;
}

function integer(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value.trim())) throw new UsageError(`${flag} expects a whole number, got "${value}"`);
	return Number(value);
}

function parseExtra(entries: string[] | undefined): Record<string, unknown> | undefined {
	if (!entries || entries.length === 0) return undefined;
	const extra: Record<string, unknown> = {};
	for (const entry of entries) {
		const split = entry.indexOf("=");
		if (split <= 0) throw new UsageError(`--extra expects key=value, got "${entry}"`);
		const raw = entry.slice(split + 1);
		let value: unknown = raw;
		try {
			value = JSON.parse(raw);
		} catch {
			// Not JSON: keep the text as a string.
		}
		extra[entry.slice(0, split)] = value;
	}
	return extra;
}

/** Show elapsed time on stderr while a request runs. Returns a function that clears it. */
function progress(label: string): () => void {
	const err = process.stderr;
	if (!err.isTTY) {
		err.write(`${label}…\n`);
		return () => {};
	}
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const startedAt = Date.now();
	let tick = 0;
	const draw = () => {
		const seconds = Math.floor((Date.now() - startedAt) / 1000);
		err.write(`\r${frames[tick++ % frames.length]} ${label}… ${seconds}s `);
	};
	draw();
	const timer = setInterval(draw, 100);
	return () => {
		clearInterval(timer);
		err.write("\r\x1b[2K");
	};
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** Whether this module is the program being run, rather than an import from a test or another module. */
function isEntryPoint(): boolean {
	// Node 24.2+ and Bun answer directly. A compiled binary depends on this:
	// its argv[1] is a path inside the executable, not a file on disk.
	if (typeof import.meta.main === "boolean") return import.meta.main;
	try {
		return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	main().then(
		code => {
			process.exitCode = code;
		},
		error => {
			process.exitCode = report(error);
		},
	);
}
