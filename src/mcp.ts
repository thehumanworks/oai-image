import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openInBrowser } from "./auth/browser-login.ts";
import { AuthManager, type AuthProvider, defaultAuth, defaultAuthManager } from "./auth/manager.ts";
import { FileTokenStore } from "./auth/store.ts";
import { type GenerateOptions, type ImageResult, OaiImage, type OaiImageOptions, sizingJson } from "./client.ts";
import { DEFAULT_IMAGE_MODEL, ENV, KNOWN_IMAGE_MODELS, MAX_INPUT_IMAGES, PACKAGE_NAME, PACKAGE_VERSION } from "./constants.ts";
import { AuthRequiredError, errorReport, OaiImageError, UsageLimitError } from "./errors.ts";
import { expandHome, type SavedImage, saveImages } from "./output.ts";
import {
	QUALITY_DESCRIPTION,
	RATIO_DESCRIPTION,
	RATIO_PATTERN,
	SIZE_DESCRIPTION,
	SIZE_PATTERN,
	SIZING_INSTRUCTIONS,
} from "./tool-text.ts";

export interface McpServerOptions {
	/** Client to generate with. Default: one built from the saved login. */
	client?: OaiImage;
	/** Options for the default client. Ignored when `client` is given. */
	clientOptions?: OaiImageOptions;
	/** Login manager behind the `auth_status` and `login` tools. Default: the saved login. */
	authManager?: AuthManager;
	/** Use the Codex CLI's login instead of this package's own. */
	useCodexAuth?: boolean;
	/** Where images go when a call names no directory. */
	outputDir?: string;
	/**
	 * Images up to this many bytes are also returned inline so the model can
	 * see them. Default 3 MiB; 0 never inlines.
	 */
	inlineMaxBytes?: number;
	/** Milliseconds between progress notifications while an image renders. Default 5000. */
	progressIntervalMs?: number;
}

const DEFAULT_INLINE_MAX_BYTES = 3 * 1024 * 1024;

const SERVER_INSTRUCTIONS = `Generates and edits images with OpenAI's image models, billed to the user's ChatGPT subscription.
Images are saved to disk and their paths returned. A generation usually takes 20 seconds to 2 minutes.
If a tool reports that nobody is signed in, ask the user before calling \`login\`, or tell them to run \`oai-image login\` in a terminal.
${SIZING_INSTRUCTIONS}`;

const sharedShape = {
	size: z
		.string()
		.regex(SIZE_PATTERN, 'Use "auto", a preset name, or WIDTHxHEIGHT such as 1536x1024')
		.optional()
		.describe(SIZE_DESCRIPTION),
	aspect_ratio: z.string().regex(RATIO_PATTERN, "Use WIDTH:HEIGHT, such as 16:9").optional().describe(RATIO_DESCRIPTION),
	quality: z.enum(["auto", "low", "medium", "high"]).optional().describe(QUALITY_DESCRIPTION),
	background: z
		.enum(["auto", "opaque", "transparent"])
		.optional()
		.describe('Default "opaque". Use "transparent" for cutouts, stickers and logos.'),
	n: z.number().int().min(1).max(4).optional().describe("How many images to make. Default 1."),
	model: z
		.string()
		.optional()
		.describe(`Image model id. Default ${DEFAULT_IMAGE_MODEL}. Leave unset unless the user asks for a specific model.`),
	output_dir: z.string().optional().describe("Directory to save into. Default: the server's configured output directory."),
	filename: z
		.string()
		.optional()
		.describe("Base file name without extension. Default: derived from the prompt. Existing files are never overwritten."),
	return_image: z
		.boolean()
		.optional()
		.describe("Also return the image inline so you can look at it (default true for images under the size cap)."),
};

const resultShape = {
	images: z.array(
		z.object({
			path: z.string(),
			mime_type: z.string(),
			width: z.number().optional(),
			height: z.number().optional(),
			bytes: z.number(),
		}),
	),
	operation: z.enum(["generate", "edit"]),
	model: z.string().describe("Model id that was requested; the backend does not report which one ran."),
	sizing: z
		.object({
			requested: z.object({ size: z.string().optional(), aspect_ratio: z.string().optional() }),
			sent: z.object({ size: z.string(), kind: z.enum(["auto", "exact", "preset", "ratio"]), hint: z.string().optional() }),
			actual: z.object({ width: z.number(), height: z.number(), ratio: z.number(), megapixels: z.number() }).optional(),
			backend_size: z.string().optional(),
		})
		.describe("What size was asked for, what was sent, and what came back."),
	warnings: z.array(
		z.object({
			code: z.enum(["ratio_snapped", "size_reduced", "size_changed", "shape_changed", "fewer_images", "background_ignored", "not_gif"]),
			message: z.string(),
		}),
	),
	request_id: z.string().optional(),
};

interface ToolExtra {
	signal: AbortSignal;
	_meta?: { progressToken?: string | number };
	sendNotification: (notification: {
		method: "notifications/progress";
		params: { progressToken: string | number; progress: number; message?: string };
	}) => Promise<void>;
}

/** Build the MCP server. Connect it to a transport yourself, or use {@link runStdioServer}. */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
	const authManager = options.authManager ?? defaultAuthManager({ useCodexAuth: options.useCodexAuth });
	const auth: AuthProvider =
		options.clientOptions?.auth ?? (options.authManager ? authManager : defaultAuth({ useCodexAuth: options.useCodexAuth }));
	const client = options.client ?? new OaiImage({ ...options.clientOptions, auth });
	const inlineMaxBytes = options.inlineMaxBytes ?? envInteger(ENV.inlineMaxBytes) ?? DEFAULT_INLINE_MAX_BYTES;
	const progressIntervalMs = options.progressIntervalMs ?? 5000;
	let pendingLogin: { method: "device" | "browser"; url: string; code?: string; error?: string } | undefined;

	const server = new McpServer(
		{ name: PACKAGE_NAME, version: PACKAGE_VERSION },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	const run = async (
		request: GenerateOptions,
		args: { output_dir?: string; filename?: string; return_image?: boolean },
		extra: ToolExtra,
	): Promise<CallToolResult> => {
		const startedAt = Date.now();
		const progressToken = extra._meta?.progressToken;
		// Rendering outlasts many clients' default tool timeout; progress keeps the call alive.
		const timer =
			progressToken === undefined
				? undefined
				: setInterval(() => {
						const seconds = Math.round((Date.now() - startedAt) / 1000);
						extra
							.sendNotification({
								method: "notifications/progress",
								params: { progressToken, progress: seconds, message: `Rendering… ${seconds}s` },
							})
							.catch(() => undefined);
					}, progressIntervalMs);
		try {
			const result = await client.generate({ ...request, signal: extra.signal });
			const dir = await resolveOutputDir(args.output_dir ?? options.outputDir);
			const saved = await saveImages(result.images, {
				dir,
				nameHint: request.prompt,
				// Reduced to a bare name by saveImages; the directory comes from output_dir alone.
				baseName: args.filename,
			});
			return success(result, saved, args.return_image, inlineMaxBytes);
		} catch (error) {
			return failure(error);
		} finally {
			clearInterval(timer);
		}
	};

	server.registerTool(
		"generate_image",
		{
			title: "Generate image",
			description:
				"Create an image from a text description using the user's ChatGPT subscription. " +
				"Saves the result to disk and returns its path. Pass reference_images to guide the result with existing images. " +
				"Describe the subject, style, composition, lighting and any text that must appear.",
			inputSchema: {
				prompt: z.string().min(1).describe("What to draw."),
				reference_images: z
					.array(z.string())
					.max(MAX_INPUT_IMAGES)
					.optional()
					.describe("Paths (or data:/https: URLs) of images to use as references. In the prompt, refer to them by order."),
				...sharedShape,
			},
			outputSchema: resultShape,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		(args, extra) =>
			run(
				{
					prompt: args.prompt,
					images: args.reference_images,
					size: args.size,
					aspectRatio: args.aspect_ratio,
					quality: args.quality,
					background: args.background,
					n: args.n,
					model: args.model,
				},
				args,
				extra as unknown as ToolExtra,
			),
	);

	server.registerTool(
		"edit_image",
		{
			title: "Edit image",
			description:
				"Change existing images according to instructions: add or remove elements, restyle, combine several images, " +
				"or remove a background. The first image is the one edited; the others are references. " +
				"Saves the result as a new file and returns its path; the originals are untouched.",
			inputSchema: {
				prompt: z.string().min(1).describe("What to change. Say what must stay the same."),
				images: z
					.array(z.string())
					.min(1)
					.max(MAX_INPUT_IMAGES)
					.describe("Paths (or data:/https: URLs) of the images to edit."),
				...sharedShape,
			},
			outputSchema: resultShape,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		(args, extra) =>
			run(
				{
					prompt: args.prompt,
					images: args.images,
					size: args.size,
					aspectRatio: args.aspect_ratio,
					quality: args.quality,
					background: args.background,
					n: args.n,
					model: args.model,
				},
				args,
				extra as unknown as ToolExtra,
			),
	);

	server.registerTool(
		"auth_status",
		{
			title: "Sign-in status",
			description: "Report whether a ChatGPT account is signed in for image generation, and which one.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => {
			try {
				if (process.env[ENV.accessToken]?.trim() && !options.authManager && !options.useCodexAuth) {
					const resolved = await auth.getAuth();
					return text(`Using the access token in ${ENV.accessToken}${resolved.identity.email ? ` (${resolved.identity.email})` : ""}.`);
				}
				const status = await authManager.status();
				if (status.loggedIn) {
					const lines = [
						`Signed in as ${status.identity?.email ?? "(unknown email)"}${status.identity?.planType ? ` on the ${status.identity.planType} plan` : ""}.`,
						`Credentials: ${status.location}`,
						`Default model: ${DEFAULT_IMAGE_MODEL}. Known models: ${KNOWN_IMAGE_MODELS.join(", ")}.`,
					];
					return text(lines.join("\n"));
				}
				if (pendingLogin?.error) return text(`Not signed in. The last sign-in attempt failed: ${pendingLogin.error}`);
				if (pendingLogin) {
					return text(
						`Not signed in yet. A sign-in is waiting for the user at ${pendingLogin.url}` +
							(pendingLogin.code ? ` with code ${pendingLogin.code}.` : "."),
					);
				}
				return text("Not signed in. Call the `login` tool, or ask the user to run `oai-image login` in a terminal.");
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"login",
		{
			title: "Sign in with ChatGPT",
			description:
				"Start signing the user in with their ChatGPT account. Returns a link (and, for the device method, a one-time code) " +
				"that the user must open themselves; sign-in completes in the background. " +
				"Only call this when the user has asked to sign in. Check `auth_status` afterwards.",
			inputSchema: {
				method: z
					.enum(["device", "browser"])
					.optional()
					.describe('"device" (default) shows a code to enter on a web page and works anywhere. "browser" opens the sign-in page on the machine running this server.'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async ({ method }) => {
			try {
				if (authManager.store instanceof FileTokenStore && authManager.store.shared) {
					return failure(new OaiImageError("This server uses the Codex CLI's login. Ask the user to run `codex login`."));
				}
				if (method === "browser") {
					const login = await authManager.startBrowserLogin();
					const state = { method: "browser" as const, url: login.authUrl, error: undefined as string | undefined };
					pendingLogin = state;
					login.wait().then(
						() => {
							if (pendingLogin === state) pendingLogin = undefined;
						},
						(error: unknown) => {
							state.error = error instanceof Error ? error.message : String(error);
						},
					);
					const opened = await openInBrowser(login.authUrl);
					return text(
						`${opened ? "A browser window should have opened for the user to sign in." : "Ask the user to open this link to sign in:"}\n` +
							`${login.authUrl}\n\nSign-in finishes on its own once they approve. Call auth_status to confirm.`,
					);
				}
				const login = await authManager.startDeviceLogin();
				const state = {
					method: "device" as const,
					url: login.verificationUrl,
					code: login.userCode,
					error: undefined as string | undefined,
				};
				pendingLogin = state;
				login.wait().then(
					() => {
						if (pendingLogin === state) pendingLogin = undefined;
					},
					(error: unknown) => {
						state.error = error instanceof Error ? error.message : String(error);
					},
				);
				return text(
					"Ask the user to finish signing in:\n" +
						`1. Open ${login.verificationUrl}\n` +
						`2. Enter the code ${login.userCode}\n\n` +
						"The code expires in 15 minutes. Sign-in finishes on its own once they approve. Call auth_status to confirm.",
				);
			} catch (error) {
				return failure(error);
			}
		},
	);

	return server;
}

/** Serve MCP over stdio until the client disconnects. stdout carries the protocol; logs go to stderr. */
export async function runStdioServer(options: McpServerOptions = {}): Promise<void> {
	const server = createMcpServer(options);
	const transport = new StdioServerTransport();
	const closed = new Promise<void>(resolve => {
		transport.onclose = () => resolve();
	});
	await server.connect(transport);
	process.stderr.write(`${PACKAGE_NAME} MCP server ${PACKAGE_VERSION} ready on stdio\n`);
	const stop = () => {
		server.close().catch(() => undefined);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.stdin.once("end", stop);
	await closed;
}

/**
 * Where images go when a call names no directory: `OAI_IMAGE_OUTPUT_DIR`,
 * else `generated_images` under the working directory, else `~/oai-image`
 * when the working directory is not writable (desktop apps start servers in `/`).
 */
export async function resolveOutputDir(requested?: string): Promise<string> {
	const explicit = requested?.trim() || process.env[ENV.outputDir]?.trim();
	if (explicit) return path.resolve(expandHome(explicit));
	const cwd = process.cwd();
	if (cwd !== path.parse(cwd).root) {
		try {
			await fs.access(cwd, fs.constants.W_OK);
			return path.join(cwd, "generated_images");
		} catch {
			// Fall through to the home directory.
		}
	}
	return path.join(os.homedir(), "oai-image");
}

function success(
	result: ImageResult,
	saved: readonly SavedImage[],
	returnImage: boolean | undefined,
	inlineMaxBytes: number,
): CallToolResult {
	const lines = [
		`${result.operation === "edit" ? "Edited" : "Generated"} ${saved.length} image${saved.length === 1 ? "" : "s"} (model requested: ${result.model}).`,
	];
	const content: CallToolResult["content"] = [];
	const skipped: string[] = [];
	for (const [position, { path: file, image }] of saved.entries()) {
		const dimensions = image.width && image.height ? `${image.width}x${image.height} ` : "";
		lines.push(`${position + 1}. ${file} (${dimensions}${image.extension.toUpperCase()}, ${formatBytes(image.byteLength)})`);
		if (returnImage === false) continue;
		if (image.byteLength <= inlineMaxBytes) {
			content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
		} else {
			skipped.push(file);
		}
	}
	if (skipped.length > 0) {
		lines.push(`Not shown inline (larger than ${formatBytes(inlineMaxBytes)}): ${skipped.join(", ")}. Open the file to view it.`);
	}
	for (const warning of result.warnings) lines.push(`Warning: ${warning.message}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }, ...content],
		structuredContent: {
			images: saved.map(({ path: file, image }) => ({
				path: file,
				mime_type: image.mimeType,
				...(image.width ? { width: image.width } : {}),
				...(image.height ? { height: image.height } : {}),
				bytes: image.byteLength,
			})),
			operation: result.operation,
			model: result.model,
			sizing: sizingJson(result.sizing),
			warnings: result.warnings,
			...(result.requestId ? { request_id: result.requestId } : {}),
		},
	};
}


function failure(error: unknown): CallToolResult {
	let message = error instanceof Error ? error.message : String(error);
	if (error instanceof AuthRequiredError) {
		message += " In this chat you can also call the `login` tool once the user agrees to sign in.";
	} else if (error instanceof UsageLimitError) {
		message += " Do not retry until the limit resets.";
	} else if (!(error instanceof OaiImageError)) {
		message = `Unexpected error: ${message}`;
	}
	return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ...errorReport(error), message } };
}

function text(value: string): CallToolResult {
	return { content: [{ type: "text", text: value }] };
}

function envInteger(name: string): number | undefined {
	const value = process.env[name]?.trim();
	return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
