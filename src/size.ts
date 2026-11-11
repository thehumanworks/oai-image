import { ValidationError } from "./errors.ts";

export type ImageShape = "square" | "landscape" | "portrait";

export interface ResolvedSize {
	/** Value for the request's `size` field. */
	size: string;
	width?: number;
	height?: number;
	shape?: ImageShape;
	/** Aspect ratio as the caller wrote it, or reduced from the pixel size. */
	ratio?: string;
	/** True when the caller asked for exact pixels, false when they gave a ratio or a named shape. */
	exact: boolean;
}

const NAMED_SIZES: Readonly<Record<string, string>> = {
	square: "1024x1024",
	landscape: "1536x1024",
	portrait: "1024x1536",
	"2k": "2048x2048",
	"4k": "3840x2160",
};

const STANDARD_RATIOS: Readonly<Record<string, string>> = {
	"1:1": "1024x1024",
	"3:2": "1536x1024",
	"2:3": "1024x1536",
};

const LONG_EDGE = 1536;
const EDGE_MULTIPLE = 16;
const MAX_RATIO = 3;

/**
 * Turn a `size` (`auto`, `WIDTHxHEIGHT`, or a name such as `landscape`) or an
 * aspect ratio (`16:9`) into the request's `size` value.
 *
 * Explicit pixel sizes are passed through unchecked beyond their syntax: the
 * limits differ per model and the backend is the authority on them.
 */
export function resolveSize(size?: string, aspectRatio?: string): ResolvedSize {
	const requested = size?.trim().toLowerCase();
	const ratio = aspectRatio?.trim();
	if (requested && requested !== "auto" && ratio) {
		throw new ValidationError("Give either a size or an aspect ratio, not both");
	}
	if (ratio) return fromAspectRatio(ratio);
	if (!requested || requested === "auto") return { size: "auto", exact: false };

	const named = NAMED_SIZES[requested];
	const match = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(named ?? requested);
	if (!match) {
		throw new ValidationError(
			`Invalid size "${size}". Use "auto", WIDTHxHEIGHT (for example 1536x1024), or one of: ${Object.keys(NAMED_SIZES).join(", ")}`,
		);
	}
	const width = Number(match[1]);
	const height = Number(match[2]);
	return {
		size: `${width}x${height}`,
		width,
		height,
		shape: shapeOf(width, height),
		ratio: simplifyRatio(width, height),
		exact: named === undefined,
	};
}

function fromAspectRatio(ratio: string): ResolvedSize {
	const match = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(ratio);
	const w = match ? Number(match[1]) : Number.NaN;
	const h = match ? Number(match[2]) : Number.NaN;
	if (!(w > 0) || !(h > 0)) {
		throw new ValidationError(`Invalid aspect ratio "${ratio}". Use WIDTH:HEIGHT, for example 16:9`);
	}
	if (Math.max(w / h, h / w) > MAX_RATIO) {
		throw new ValidationError(`Aspect ratio "${ratio}" is too extreme; the long edge may be at most 3x the short edge`);
	}
	const standard = STANDARD_RATIOS[`${w}:${h}`];
	let width: number;
	let height: number;
	if (standard) {
		[width, height] = standard.split("x").map(Number) as [number, number];
	} else if (w >= h) {
		width = LONG_EDGE;
		height = roundToMultiple((LONG_EDGE * h) / w);
	} else {
		height = LONG_EDGE;
		width = roundToMultiple((LONG_EDGE * w) / h);
	}
	return {
		size: `${width}x${height}`,
		width,
		height,
		shape: shapeOf(width, height),
		ratio: `${match?.[1]}:${match?.[2]}`,
		exact: false,
	};
}

/**
 * A sentence stating the wanted canvas, appended to the prompt.
 *
 * The ChatGPT backend is reported to pick the canvas from the prompt and to
 * disregard the `size` field, so the shape is spelled out as well.
 */
export function sizeHint(resolved: ResolvedSize): string | undefined {
	if (!resolved.width || !resolved.height || !resolved.shape) return undefined;
	const detail = resolved.exact
		? `${resolved.width}x${resolved.height} pixels`
		: `${resolved.ratio ?? simplifyRatio(resolved.width, resolved.height)} aspect ratio`;
	return `Output format: ${resolved.shape} image, ${detail}.`;
}

function shapeOf(width: number, height: number): ImageShape {
	return width === height ? "square" : width > height ? "landscape" : "portrait";
}

function roundToMultiple(value: number): number {
	return Math.max(EDGE_MULTIPLE, Math.round(value / EDGE_MULTIPLE) * EDGE_MULTIPLE);
}

function simplifyRatio(width: number, height: number): string {
	const divisor = gcd(width, height);
	return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}
