import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OaiImageError, ValidationError } from "./errors.ts";
import { readImageSize, sniffImageFormat } from "./image-format.ts";

/** One image returned by the backend. */
export class GeneratedImage {
	/** Position in the response, starting at 0. */
	readonly index: number;
	/** The image, base64-encoded exactly as received. */
	readonly base64: string;
	/** Detected from the image bytes. */
	readonly mimeType: string;
	/** File extension matching {@link mimeType}, without a dot. */
	readonly extension: string;
	/** Pixel width read from the image itself. */
	readonly width?: number;
	readonly height?: number;
	/** Backend id of this generation, when it reports one. */
	readonly generationId?: string;
	#bytes: Buffer | undefined;

	constructor(base64: string, index: number, generationId?: string) {
		this.base64 = base64.trim();
		this.index = index;
		this.generationId = generationId;
		const bytes = this.bytes;
		const format = sniffImageFormat(bytes) ?? { mimeType: "image/png", extension: "png" };
		this.mimeType = format.mimeType;
		this.extension = format.extension;
		const size = readImageSize(bytes);
		this.width = size?.width;
		this.height = size?.height;
	}

	get bytes(): Buffer {
		this.#bytes ??= Buffer.from(this.base64, "base64");
		return this.#bytes;
	}

	get byteLength(): number {
		return this.bytes.length;
	}

	toDataUrl(): string {
		return `data:${this.mimeType};base64,${this.base64}`;
	}

	/**
	 * Write the image to `file`. Refuses to replace an existing file unless
	 * `overwrite` is set.
	 *
	 * @returns the absolute path written.
	 */
	async save(file: string, options: { overwrite?: boolean } = {}): Promise<string> {
		const target = path.resolve(expandHome(file));
		await fs.mkdir(path.dirname(target), { recursive: true });
		try {
			await fs.writeFile(target, this.bytes, { flag: options.overwrite ? "w" : "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new OaiImageError(`${target} already exists; choose another name or allow overwriting`, {
					cause: error,
				});
			}
			throw error;
		}
		return target;
	}
}

export interface SaveImagesOptions {
	/**
	 * Exact destination. With several images, later ones get `-2`, `-3`, …
	 * before the extension. A missing extension is filled in from the image
	 * format. An existing file is an error unless `overwrite` is set.
	 */
	file?: string;
	/** Directory for generated names. Default: the current directory. Ignored when `file` is given. */
	dir?: string;
	/** Text the generated name is derived from, usually the prompt. */
	nameHint?: string;
	/**
	 * Exact base name (no directory, no extension) to use inside `dir` instead
	 * of a generated one. A counter is added if the name is taken.
	 */
	baseName?: string;
	overwrite?: boolean;
	/** Clock, for tests. */
	now?: Date;
}

export interface SavedImage {
	path: string;
	image: GeneratedImage;
}

/**
 * Write images to disk. Without `file`, names are generated as
 * `oai-image-<timestamp>-<prompt-slug>.<ext>` and never collide with existing
 * files.
 */
export async function saveImages(images: readonly GeneratedImage[], options: SaveImagesOptions = {}): Promise<SavedImage[]> {
	const saved: SavedImage[] = [];
	if (options.file) {
		const target = path.resolve(expandHome(options.file));
		const parsed = path.parse(target);
		for (const [position, image] of images.entries()) {
			const extension = parsed.ext || `.${image.extension}`;
			const suffix = position === 0 ? "" : `-${position + 1}`;
			const file = path.join(parsed.dir, `${parsed.name}${suffix}${extension}`);
			saved.push({ path: await image.save(file, { overwrite: options.overwrite }), image });
		}
		return saved;
	}

	const dir = path.resolve(expandHome(options.dir ?? "."));
	await fs.mkdir(dir, { recursive: true });
	const custom = options.baseName ? sanitizeBaseName(options.baseName) : "";
	const stem =
		custom || ["oai-image", timestamp(options.now ?? new Date()), slugify(options.nameHint)].filter(Boolean).join("-");
	for (const [position, image] of images.entries()) {
		const base = images.length > 1 ? `${stem}-${position + 1}` : stem;
		saved.push({ path: await writeUnique(dir, base, image), image });
	}
	return saved;
}

/** Create the file exclusively, adding a counter until the name is free. */
async function writeUnique(dir: string, base: string, image: GeneratedImage): Promise<string> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const name = attempt === 0 ? base : `${base}_${attempt + 1}`;
		const file = path.join(dir, `${name}.${image.extension}`);
		try {
			await fs.writeFile(file, image.bytes, { flag: "wx" });
			return file;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new OaiImageError(`Could not find a free file name for ${base} in ${dir}`);
}

/** Reduce a caller-supplied name to a single safe path segment without an image extension. */
function sanitizeBaseName(name: string): string {
	return path
		.basename(name.replace(/\\/g, "/"))
		.replace(/\.(png|jpe?g|webp|gif|svg)$/i, "")
		.replace(/[^\w.-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 120);
}

/** A short, filesystem-safe rendering of free text. */
export function slugify(text: string | undefined, maxLength = 40): string {
	if (!text) return "";
	const slug = text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.slice(0, maxLength).replace(/-+$/, "");
}

export function expandHome(file: string): string {
	if (file === "~") return os.homedir();
	if (file.startsWith("~/") || file.startsWith("~\\")) return path.join(os.homedir(), file.slice(2));
	return file;
}

function timestamp(date: Date): string {
	if (Number.isNaN(date.getTime())) throw new ValidationError("Invalid date");
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}
