import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./errors.ts";
import { formatFromExtension, sniffImageFormat } from "./image-format.ts";
import { expandHome } from "./output.ts";

/**
 * An image to edit or to use as a reference:
 *
 * - a file path (`~` is expanded) or `file:` URL;
 * - a `data:image/...;base64,` URL;
 * - an `http(s)` URL, handed to the backend as is (nothing is downloaded locally);
 * - raw bytes, or `{ data, mimeType }` where `data` is bytes or base64;
 * - `{ fileId }` for a file already uploaded to OpenAI.
 */
export type ImageInput =
	| string
	| URL
	| Uint8Array
	| { data: Uint8Array | string; mimeType?: string }
	| { fileId: string };

/** The wire form of an input image on `images/edits`. */
export type ImageReference = { image_url: string } | { file_id: string };

/** Largest input image accepted, matching the Images API limit. */
export const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;

export async function toImageReference(input: ImageInput): Promise<ImageReference> {
	if (input instanceof URL) {
		if (input.protocol === "file:") return fromFile(fileURLToPath(input));
		return toImageReference(input.href);
	}
	if (typeof input === "string") {
		const value = input.trim();
		if (/^data:/i.test(value)) {
			if (!/^data:image\/[\w.+-]+;base64,/i.test(value)) {
				throw new ValidationError("Image data URLs must look like data:image/<type>;base64,<data>");
			}
			return { image_url: value };
		}
		if (/^https?:\/\//i.test(value)) return { image_url: value };
		if (/^file:\/\//i.test(value)) return fromFile(fileURLToPath(value));
		if (value.length === 0) throw new ValidationError("An input image path is empty");
		return fromFile(value);
	}
	if (input instanceof Uint8Array) return fromBytes(input, undefined, "image bytes");
	if ("fileId" in input) {
		if (!input.fileId) throw new ValidationError("An input image has an empty fileId");
		return { file_id: input.fileId };
	}
	const bytes = typeof input.data === "string" ? Buffer.from(input.data, "base64") : input.data;
	return fromBytes(bytes, input.mimeType, "image data");
}

async function fromFile(file: string): Promise<ImageReference> {
	const resolved = path.resolve(expandHome(file));
	let bytes: Buffer;
	try {
		const stat = await fs.stat(resolved);
		if (!stat.isFile()) throw new ValidationError(`Input image ${resolved} is not a file`);
		if (stat.size > MAX_INPUT_IMAGE_BYTES) throw tooLarge(resolved);
		bytes = await fs.readFile(resolved);
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		throw new ValidationError(
			code === "ENOENT" ? `Input image not found: ${resolved}` : `Cannot read input image ${resolved}: ${String(error)}`,
			{ cause: error },
		);
	}
	return fromBytes(bytes, formatFromExtension(resolved)?.mimeType, resolved);
}

function fromBytes(bytes: Uint8Array, declaredMimeType: string | undefined, label: string): ImageReference {
	if (bytes.length === 0) throw new ValidationError(`Input ${label} is empty`);
	if (bytes.length > MAX_INPUT_IMAGE_BYTES) throw tooLarge(label);
	// Trust the bytes over the name: a mislabelled image is rejected by the backend.
	const mimeType = sniffImageFormat(bytes)?.mimeType ?? declaredMimeType;
	if (!mimeType?.startsWith("image/")) {
		throw new ValidationError(`Input ${label} is not a recognized image (PNG, JPEG, WebP or GIF)`);
	}
	return { image_url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
}

function tooLarge(label: string): ValidationError {
	return new ValidationError(`Input image ${label} is larger than ${MAX_INPUT_IMAGE_BYTES / 1024 / 1024} MB`);
}
