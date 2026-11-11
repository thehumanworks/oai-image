import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Set to a compiled `oai-image` executable to run the process-level tests
 * against it instead of the TypeScript source (`npm run test:binary`).
 */
export const TEST_BINARY = process.env.OAI_IMAGE_TEST_BIN ? path.resolve(process.env.OAI_IMAGE_TEST_BIN) : undefined;

const CLI_SOURCE = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** How to start the CLI under test: the compiled binary if one was named, otherwise the source under Node. */
export function cliCommand(args: string[]): { command: string; args: string[] } {
	return TEST_BINARY ? { command: TEST_BINARY, args } : { command: process.execPath, args: [CLI_SOURCE, ...args] };
}

export interface RecordedRequest {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
	json: any;
	form: URLSearchParams;
}

export type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
export type Handler = (request: RecordedRequest) => Reply | Promise<Reply>;

export interface MockServer {
	url: string;
	requests: RecordedRequest[];
	/** Requests whose path ends with `suffix`. */
	to(suffix: string): RecordedRequest[];
	close(): Promise<void>;
}

/** A local HTTP server whose every request is recorded and answered by `handler`. */
export async function mockServer(handler: Handler): Promise<MockServer> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks).toString("utf8");
		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			json = undefined;
		}
		const recorded: RecordedRequest = {
			method: request.method ?? "",
			path: request.url ?? "",
			headers: request.headers,
			body,
			json,
			form: new URLSearchParams(body),
		};
		requests.push(recorded);
		try {
			const reply = await handler(recorded);
			const payload = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? "");
			response.writeHead(reply.status ?? 200, {
				"Content-Type": reply.json !== undefined ? "application/json" : "text/plain",
				...reply.headers,
			});
			response.end(payload);
		} catch (error) {
			response.writeHead(500, { "Content-Type": "text/plain" });
			response.end(String(error));
		}
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		to: suffix => requests.filter(request => request.path.split("?")[0]?.endsWith(suffix)),
		close: () =>
			new Promise<void>(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** An unsigned JWT carrying `payload`; enough for code that only reads claims. */
export function makeJwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

export function accessToken(options: { expiresInSeconds?: number; accountId?: string; extra?: Record<string, unknown>; nonce?: string } = {}): string {
	return makeJwt({
		exp: Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600),
		nonce: options.nonce ?? "a",
		"https://api.openai.com/auth": {
			chatgpt_account_id: options.accountId ?? "acct-123",
			chatgpt_plan_type: "plus",
			chatgpt_user_id: "user-1",
			...options.extra,
		},
	});
}

export function idToken(email = "Person@Example.com"): string {
	return makeJwt({
		email,
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "plus" },
	});
}

/** A syntactically valid PNG header with the given dimensions (signature + IHDR). */
export function pngBytes(width = 1024, height = 1024): Buffer {
	const header = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
	header.writeUInt32BE(13, 8);
	header.write("IHDR", 12, "ascii");
	header.writeUInt32BE(width, 16);
	header.writeUInt32BE(height, 20);
	header[24] = 8;
	header[25] = 6;
	return header;
}

/** A PNG header followed by filler, for output paths that must cope with real file sizes. */
export function largePng(byteLength: number): Buffer {
	const image = Buffer.alloc(byteLength);
	for (let i = 0; i < byteLength; i++) image[i] = (i * 31 + (i >>> 8)) & 0xff;
	pngBytes(2048, 2048).copy(image, 0);
	return image;
}

export function gifBytes(width = 64, height = 48): Buffer {
	const header = Buffer.alloc(13);
	header.write("GIF89a", 0, "ascii");
	header.writeUInt16LE(width, 6);
	header.writeUInt16LE(height, 8);
	return header;
}

/** The success body the ChatGPT backend returns for an image request. */
export function imageResponse(images: Buffer[] = [pngBytes()], extra: Record<string, unknown> = {}) {
	return {
		created: 1778832973,
		background: "opaque",
		data: images.map((image, index) => ({ b64_json: image.toString("base64"), generation_id: `gen-${index + 1}` })),
		output_format: "png",
		quality: "medium",
		size: "1024x1024",
		usage: { input_tokens: 17, output_tokens: 1372, total_tokens: 1389 },
		...extra,
	};
}

export async function tempDir(prefix = "oai-image-test-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
