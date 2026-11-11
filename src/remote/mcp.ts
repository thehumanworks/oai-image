import {
	type AuthInfo,
	type CallToolResult,
	createMcpHandler,
	McpServer,
	type McpRequestContext,
	MissingRequiredClientCapabilityError,
	ProtocolError,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { DEFAULT_IMAGE_MODEL, MAX_INPUT_IMAGES, PACKAGE_NAME, PACKAGE_VERSION } from "../constants.ts";
import { type Env, type GrantProps, publicOrigin, vaultStub } from "./env.ts";
import { signedImageUrl } from "./images.ts";
import type { Job, JobRequest, VaultResult } from "./vault.ts";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const INVALID_PARAMS = -32602;

/** Images up to this size are returned inline as well as by link. */
const INLINE_MAX_BYTES = 3 * 1024 * 1024;
/** And no more than this in one result, since `tasks/get` may be polled after completion. */
const INLINE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
/** Accepts data: URLs of input images, so larger than the SDK's 4 MiB default. */
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;

const INSTRUCTIONS = `Generates and edits images with OpenAI's image models, billed to the signed-in user's own ChatGPT plan.
A render usually takes 20 seconds to 2 minutes. Clients that support the MCP Tasks extension get a task to poll; others can pass run_in_background and check get_image_job.
Results include a download link valid for 24 hours, and the image inline when it is small enough.`;

/** Everything a tool call needs about its caller, taken from the verified grant. */
export interface Caller {
	props: GrantProps;
	/** `{userId}:{grantId}` of the grant, for revoking it. */
	userId?: string;
	grantId?: string;
}

const shared = {
	size: z
		.string()
		.optional()
		.describe('Canvas: "auto" (default), WIDTHxHEIGHT such as "1536x1024", or "square", "landscape", "portrait", "2k", "4k".'),
	aspect_ratio: z.string().optional().describe('Aspect ratio such as "16:9", instead of size.'),
	quality: z.enum(["auto", "low", "medium", "high"]).optional().describe("Rendering quality. Higher is slower and uses more of the plan's limit."),
	background: z
		.enum(["auto", "opaque", "transparent"])
		.optional()
		.describe('Default "opaque". Use "transparent" for cutouts, stickers and logos.'),
	n: z.number().int().min(1).max(4).optional().describe("How many images to make. Default 1."),
	model: z
		.string()
		.optional()
		.describe(`Image model id. Default ${DEFAULT_IMAGE_MODEL}. Leave unset unless the user asks for a specific model.`),
	run_in_background: z
		.boolean()
		.optional()
		.describe(
			"Return a job id at once instead of waiting for the image; fetch it later with get_image_job. " +
				"Not needed when your client supports MCP tasks, which never block.",
		),
};

const imageUrl = z
	.string()
	.min(1)
	.refine(value => /^data:image\/[\w.+-]+;base64,/i.test(value) || /^https:\/\//i.test(value), {
		message: "Must be a data:image/...;base64, URL or an https:// URL. This server cannot read local files.",
	});

/** The per-request server: a fresh instance for every HTTP request, as the stateless protocol intends. */
export function createServer(env: Env, origin: string, caller: Caller): McpServer {
	const server = new McpServer(
		{ name: PACKAGE_NAME, version: PACKAGE_VERSION },
		{ capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } }, instructions: INSTRUCTIONS },
	);
	const vault = vaultStub(env, caller.props.vaultId);
	const key = caller.props.vaultKey;

	const unwrap = async <T>(result: VaultResult<T>): Promise<T> => {
		if (result.ok) return result.value;
		if (result.code === "auth_required") await revokeGrant(env, caller);
		throw new ToolFailure(result.message, result.code);
	};

	const startImageJob = async (
		request: JobRequest,
		runInBackground: boolean | undefined,
		ctx: ToolContext,
	): Promise<CallToolResult> => {
		let job: Job;
		try {
			job = await unwrap(await vault.startJob(key, request));
		} catch (error) {
			return failure(error);
		}
		if (clientSupportsTasks(ctx)) {
			// MCP Tasks extension: answer with a task handle; the client polls tasks/get.
			return { resultType: "task", ...taskView(job) } as unknown as CallToolResult;
		}
		if (runInBackground) {
			return {
				content: [
					{
						type: "text",
						text:
							`Started rendering. Job id: ${job.id}\n` +
							"Call get_image_job with this id to get the image; it usually takes 20 seconds to 2 minutes.",
					},
				],
				structuredContent: { job_id: job.id, status: job.status },
			};
		}
		// A client without tasks waits on this request, with progress notifications if it asked for them.
		const startedAt = Date.now();
		const progressToken = ctx.mcpReq._meta?.progressToken;
		for (;;) {
			const current = await vault.getJob(job.id);
			if (!current) return failure(new ToolFailure("The job disappeared before it finished.", "internal"));
			if (current.status !== "working") return jobResult(env, origin, current);
			if (ctx.mcpReq.signal.aborted) {
				await vault.cancelJob(job.id);
				return failure(new ToolFailure("Cancelled.", "cancelled"));
			}
			if (progressToken !== undefined) {
				const seconds = Math.round((Date.now() - startedAt) / 1000);
				await ctx.mcpReq
					.notify({
						method: "notifications/progress",
						params: { progressToken, progress: seconds, message: `Rendering… ${seconds}s` },
					})
					.catch(() => undefined);
			}
			await sleep(POLL_INTERVAL_MS, ctx.mcpReq.signal);
		}
	};

	server.registerTool(
		"generate_image",
		{
			title: "Generate image",
			description:
				"Create an image from a text description using the user's ChatGPT subscription. " +
				"Pass reference_images to guide the result with existing images. " +
				"Describe the subject, style, composition, lighting and any text that must appear.",
			inputSchema: z.object({
				prompt: z.string().min(1).describe("What to draw."),
				reference_images: z
					.array(imageUrl)
					.max(MAX_INPUT_IMAGES)
					.optional()
					.describe("data:image/...;base64, or https:// URLs of reference images. In the prompt, refer to them by order."),
				...shared,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		(args, ctx) =>
			startImageJob(
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
				args.run_in_background,
				ctx as unknown as ToolContext,
			),
	);

	server.registerTool(
		"edit_image",
		{
			title: "Edit image",
			description:
				"Change existing images according to instructions: add or remove elements, restyle, combine several images, " +
				"or remove a background. The first image is the one edited; the others are references.",
			inputSchema: z.object({
				prompt: z.string().min(1).describe("What to change. Say what must stay the same."),
				images: z
					.array(imageUrl)
					.min(1)
					.max(MAX_INPUT_IMAGES)
					.describe("data:image/...;base64, or https:// URLs of the images to edit."),
				...shared,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		(args, ctx) =>
			startImageJob(
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
				args.run_in_background,
				ctx as unknown as ToolContext,
			),
	);

	server.registerTool(
		"get_image_job",
		{
			title: "Get image job",
			description:
				"Check a job started with run_in_background. Returns the images when it has finished, otherwise its status. " +
				"Waits up to wait_seconds for it to finish first.",
			inputSchema: z.object({
				job_id: z.string().min(1).describe("The job id returned when the job was started."),
				wait_seconds: z.number().int().min(0).max(50).optional().describe("Wait this long for the job to finish. Default 20."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args, ctx) => {
			const signal = (ctx as unknown as ToolContext).mcpReq.signal;
			const deadline = Date.now() + (args.wait_seconds ?? 20) * 1000;
			for (;;) {
				const job = await vault.getJob(args.job_id);
				if (!job) return failure(new ToolFailure("No such job. Jobs and their images are kept for 24 hours.", "not_found"));
				if (job.status !== "working") return jobResult(env, origin, job);
				if (Date.now() + POLL_INTERVAL_MS > deadline || signal.aborted) {
					return {
						content: [{ type: "text", text: `Still rendering (job ${job.id}, started ${job.createdAt}). Check again shortly.` }],
						structuredContent: { job_id: job.id, status: job.status },
					};
				}
				await sleep(POLL_INTERVAL_MS, signal);
			}
		},
	);

	server.registerTool(
		"auth_status",
		{
			title: "Sign-in status",
			description: "Report which ChatGPT account this connection generates images with.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => {
			try {
				const who = await unwrap(await vault.status(key));
				return text(
					`Signed in as ${who.email ?? "(unknown email)"}${who.planType ? ` on the ${who.planType} plan` : ""}. ` +
						"To use another account, sign out and reconnect.",
				);
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"sign_out",
		{
			title: "Sign out",
			description:
				"Sign this connection out of ChatGPT: revokes the login at OpenAI, deletes it and every image made with it from this server, " +
				"and ends this connection's access. Only call this when the user asks to sign out.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async () => {
			try {
				const { revoked } = await unwrap(await vault.signOut(key));
				await revokeGrant(env, caller);
				return text(
					`Signed out${revoked ? "" : " (OpenAI did not confirm the revocation; you can also sign out of other devices in ChatGPT's settings)"}. ` +
						"Reconnect the server to sign in again.",
				);
			} catch (error) {
				return failure(error);
			}
		},
	);

	// --- MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28) -------------------------

	const taskParams = z.object({ taskId: z.string().min(1) }).passthrough();

	server.server.setRequestHandler("tasks/get", { params: taskParams }, async (params, ctx) => {
		requireTasks(ctx as unknown as ToolContext);
		const job = await vault.getJob(params.taskId);
		if (!job) throw new ProtocolError(INVALID_PARAMS, "Failed to retrieve task: Task not found");
		const view = { resultType: "complete", ...taskView(job) } as Record<string, unknown>;
		if (job.status === "completed") view.result = await jobResult(env, origin, job);
		return view as never;
	});

	server.server.setRequestHandler(
		"tasks/update",
		{ params: taskParams.extend({ inputResponses: z.record(z.string(), z.unknown()).optional() }) },
		async (params, ctx) => {
			requireTasks(ctx as unknown as ToolContext);
			// Image jobs never ask for input, so there is never anything outstanding to answer.
			if (!(await vault.getJob(params.taskId))) throw new ProtocolError(INVALID_PARAMS, "Task not found");
			return { resultType: "complete" } as never;
		},
	);

	server.server.setRequestHandler("tasks/cancel", { params: taskParams }, async (params, ctx) => {
		requireTasks(ctx as unknown as ToolContext);
		if (!(await vault.cancelJob(params.taskId))) throw new ProtocolError(INVALID_PARAMS, "Task not found");
		return { resultType: "complete" } as never;
	});

	return server;
}

/** The `/mcp` endpoint, behind the OAuth provider's token check. */
export function handleMcpRequest(request: Request, env: Env, caller: Caller, authInfo: AuthInfo): Promise<Response> {
	const origin = publicOrigin(env, request);
	const handler = createMcpHandler((_ctx: McpRequestContext) => createServer(env, origin, caller), {
		maxRequestBodySize: MAX_REQUEST_BYTES,
		onerror: error => console.error("mcp error:", error.message),
	});
	return handler.fetch(request, { authInfo });
}

/** The parts of the SDK's handler context this module uses. */
interface ToolContext {
	mcpReq: {
		signal: AbortSignal;
		_meta?: { progressToken?: string | number };
		envelope?: Record<string, unknown>;
		notify: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
	};
}

function clientSupportsTasks(ctx: ToolContext): boolean {
	const capabilities = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_KEY] as { extensions?: Record<string, unknown> } | undefined;
	return Boolean(capabilities?.extensions && TASKS_EXTENSION in capabilities.extensions);
}

function requireTasks(ctx: ToolContext): void {
	if (!clientSupportsTasks(ctx)) {
		throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
	}
}

/** The `Task` fields the Tasks extension defines, for a job. */
export function taskView(job: Job) {
	return {
		taskId: job.id,
		status: job.status,
		...(job.statusMessage ? { statusMessage: job.statusMessage } : {}),
		createdAt: job.createdAt,
		lastUpdatedAt: job.lastUpdatedAt,
		ttlMs: job.ttlMs,
		pollIntervalMs: POLL_INTERVAL_MS,
	};
}

/** The tool result for a finished job: links, small images inline, and structured content. */
export async function jobResult(env: Env, origin: string, job: Job): Promise<CallToolResult> {
	if (job.status === "cancelled") return failure(new ToolFailure("The job was cancelled.", "cancelled"));
	const outcome = job.outcome;
	if (!outcome) return failure(new ToolFailure("The job has not finished.", "internal"));
	if (outcome.isError) {
		let message = outcome.message ?? "The image could not be made.";
		if (outcome.code === "usage_limit") {
			message += `${outcome.resetsAt ? ` The limit resets at ${outcome.resetsAt}.` : ""} Do not retry until the limit resets.`;
		}
		return { isError: true, content: [{ type: "text", text: message }], structuredContent: { error: outcome.code ?? "error", message } };
	}
	const lines = [
		`${outcome.operation === "edit" ? "Edited" : "Generated"} ${outcome.images.length} image${outcome.images.length === 1 ? "" : "s"} (model requested: ${outcome.model ?? "default"}).`,
	];
	const blocks: CallToolResult["content"] = [];
	const images: Record<string, unknown>[] = [];
	let inlined = 0;
	for (const [position, image] of outcome.images.entries()) {
		const url = await signedImageUrl(env, origin, image.key);
		const dimensions = image.width && image.height ? `${image.width}x${image.height} ` : "";
		lines.push(`${position + 1}. ${url} (${dimensions}${image.extension.toUpperCase()}, ${formatBytes(image.bytes)}; link valid 24 hours)`);
		images.push({
			url,
			mime_type: image.mimeType,
			...(image.width ? { width: image.width } : {}),
			...(image.height ? { height: image.height } : {}),
			bytes: image.bytes,
		});
		blocks.push({ type: "resource_link", uri: url, name: `image-${position + 1}.${image.extension}`, mimeType: image.mimeType });
		if (image.bytes <= INLINE_MAX_BYTES && inlined + image.bytes <= INLINE_TOTAL_MAX_BYTES) {
			const object = await env.IMAGES.get(image.key);
			if (object) {
				blocks.push({ type: "image", data: toBase64(new Uint8Array(await object.arrayBuffer())), mimeType: image.mimeType });
				inlined += image.bytes;
			}
		}
	}
	for (const warning of outcome.warnings) lines.push(`Warning: ${warning}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }, ...blocks],
		structuredContent: {
			job_id: job.id,
			operation: outcome.operation,
			model: outcome.model,
			images,
			warnings: outcome.warnings,
		},
	};
}

async function revokeGrant(env: Env, caller: Caller): Promise<void> {
	if (!caller.userId || !caller.grantId) return;
	try {
		await env.OAUTH_PROVIDER.revokeGrant(caller.grantId, caller.userId);
	} catch (error) {
		console.error("revoking grant failed:", error instanceof Error ? error.message : String(error));
	}
}

class ToolFailure extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

function failure(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error);
	const code = error instanceof ToolFailure ? error.code : "internal";
	const hint = code === "auth_required" ? " Reconnect this server in your MCP client to sign in with ChatGPT again." : "";
	return { isError: true, content: [{ type: "text", text: `${message}${hint}` }] };
}

function text(value: string): CallToolResult {
	return { content: [{ type: "text", text: value }] };
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}
