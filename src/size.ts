import { ValidationError } from "./errors.ts";

export type ImageShape = "square" | "landscape" | "portrait";

/** Named sizes. Fixed canvases plus device and screen shapes resolved like an aspect ratio. */
export type SizePreset =
	| "square"
	| "landscape"
	| "portrait"
	| "2k"
	| "4k"
	| "phone"
	| "ultrawide"
	| "widescreen"
	| "story";

/** Exact pixels, `WIDTHxHEIGHT`. */
export type PixelSize = `${number}x${number}`;

/** `WIDTH:HEIGHT`, decimals allowed (`9:19.5`). */
export type AspectRatio = `${number}:${number}`;

/** Ratios offered for autocompletion; any other {@link AspectRatio} is accepted too. */
export type CommonRatio = "1:1" | "3:2" | "2:3" | "4:3" | "3:4" | "16:9" | "9:16" | "21:9" | "9:19.5";

export type SizeInput = "auto" | SizePreset | PixelSize;

/** How a size was asked for, which decides how the result is checked against it. */
export type SizeKind = "auto" | "exact" | "preset" | "ratio";

export interface ResolvedSize {
	/** Value for the request's `size` field. */
	size: "auto" | PixelSize;
	kind: SizeKind;
	width?: number;
	height?: number;
	shape?: ImageShape;
	/** Aspect ratio as the caller wrote it, or reduced from the pixel size. */
	ratio?: string;
	/** The preset name, when one was used. */
	preset?: SizePreset;
	/** `width * height / 1e6`, rounded to two decimals. */
	megapixels?: number;
}

/**
 * Pixels the backend has been seen to return on this route at every quality:
 * 1536x1024, 1820x864 and 1024x1536 are all about 1.57 MP. Ratios are
 * resolved to this budget so the `size` field and the prompt hint agree with
 * what the backend actually renders.
 */
export const OBSERVED_PIXEL_BUDGET = 1536 * 1024;

/**
 * Documented limits of the GPT Image 2 family. Older models accept a subset;
 * the backend still has the last word.
 */
export const SIZE_LIMITS = {
	edgeMultiple: 16,
	maxEdge: 3840,
	maxRatio: 3,
	minPixels: 655_360,
	maxPixels: 8_294_400,
} as const;

const FIXED_PRESETS: Readonly<Record<string, { size: PixelSize; pixelTarget: boolean }>> = {
	square: { size: "1024x1024", pixelTarget: false },
	landscape: { size: "1536x1024", pixelTarget: false },
	portrait: { size: "1024x1536", pixelTarget: false },
	"2k": { size: "2048x2048", pixelTarget: true },
	"4k": { size: "3840x2160", pixelTarget: true },
};

const RATIO_PRESETS: Readonly<Record<string, CommonRatio>> = {
	phone: "9:19.5",
	ultrawide: "21:9",
	widescreen: "16:9",
	story: "9:16",
};

export const SIZE_PRESETS = [...Object.keys(FIXED_PRESETS), ...Object.keys(RATIO_PRESETS)] as SizePreset[];

/** The canvases the backend renders at for these ratios, used as is. */
const STANDARD_RATIOS: Readonly<Record<string, PixelSize>> = {
	"1:1": "1024x1024",
	"3:2": "1536x1024",
	"2:3": "1024x1536",
};

const PIXELS = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/;
const RATIO = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/;

/**
 * Turn a `size` (`auto`, `WIDTHxHEIGHT`, or a preset such as `landscape` or
 * `phone`) or an aspect ratio (`16:9`) into the request's `size` value.
 *
 * Exact sizes are checked against {@link SIZE_LIMITS} so a size no model can
 * render fails here, with the reason, rather than upstream.
 */
export function resolveSize(size?: SizeInput | (string & {}), aspectRatio?: AspectRatio | (string & {})): ResolvedSize {
	const requested = size?.trim().toLowerCase();
	const ratio = aspectRatio?.trim();
	if (requested && requested !== "auto" && ratio) {
		throw new ValidationError("Give either a size or an aspect ratio, not both");
	}
	if (ratio) return fromAspectRatio(ratio, "ratio");
	if (!requested || requested === "auto") return { size: "auto", kind: "auto" };

	const ratioPreset = RATIO_PRESETS[requested];
	if (ratioPreset) return { ...fromAspectRatio(ratioPreset, "preset"), preset: requested as SizePreset };

	const fixed = FIXED_PRESETS[requested];
	const match = PIXELS.exec(fixed?.size ?? requested);
	if (!match) {
		throw new ValidationError(
			`Invalid size "${size}". Use "auto", WIDTHxHEIGHT (for example 1536x1024), or one of: ${SIZE_PRESETS.join(", ")}`,
		);
	}
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!fixed) checkLimits(width, height);
	return {
		size: `${width}x${height}`,
		kind: fixed ? "preset" : "exact",
		width,
		height,
		shape: shapeOf(width, height),
		ratio: simplifyRatio(width, height),
		...(fixed ? { preset: requested as SizePreset } : {}),
		megapixels: megapixels(width, height),
	};
}

/** True when the backend should be told the exact pixels rather than just the shape. */
export function isPixelTarget(resolved: ResolvedSize): boolean {
	if (resolved.kind === "exact") return true;
	return resolved.kind === "preset" && resolved.preset !== undefined && FIXED_PRESETS[resolved.preset]?.pixelTarget === true;
}

function fromAspectRatio(ratio: string, kind: "ratio" | "preset"): ResolvedSize {
	const match = RATIO.exec(ratio);
	const w = match ? Number(match[1]) : Number.NaN;
	const h = match ? Number(match[2]) : Number.NaN;
	if (!(w > 0) || !(h > 0)) {
		throw new ValidationError(`Invalid aspect ratio "${ratio}". Use WIDTH:HEIGHT, for example 16:9`);
	}
	if (Math.max(w / h, h / w) > SIZE_LIMITS.maxRatio) {
		throw new ValidationError(
			`Aspect ratio "${ratio}" is too extreme; the long edge may be at most ${SIZE_LIMITS.maxRatio}x the short edge (3:1 to 1:3)`,
		);
	}
	const [width, height] = (STANDARD_RATIOS[`${w}:${h}`]?.split("x").map(Number) ?? fitToBudget(w / h)) as [number, number];
	return {
		size: `${width}x${height}`,
		kind,
		width,
		height,
		shape: shapeOf(width, height),
		ratio: `${match?.[1]}:${match?.[2]}`,
		megapixels: megapixels(width, height),
	};
}

/**
 * The multiple-of-16 canvas closest to `ratio` within {@link OBSERVED_PIXEL_BUDGET},
 * preferring the larger canvas when two are equally close.
 */
function fitToBudget(ratio: number): [number, number] {
	const step = SIZE_LIMITS.edgeMultiple;
	const idealHeight = Math.sqrt(OBSERVED_PIXEL_BUDGET / ratio);
	let best: [number, number] | undefined;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let height = Math.floor(idealHeight / step) * step - 4 * step; height <= idealHeight + 4 * step; height += step) {
		if (height < step) continue;
		const width = Math.max(step, Math.round((height * ratio) / step) * step);
		const pixels = width * height;
		if (pixels > OBSERVED_PIXEL_BUDGET) continue;
		// Ratio accuracy first; a canvas well under budget is penalised so the result stays near full size.
		const score = Math.abs(width / height - ratio) / ratio + (1 - pixels / OBSERVED_PIXEL_BUDGET) * 0.05;
		if (score < bestScore) {
			best = [width, height];
			bestScore = score;
		}
	}
	return best ?? [1024, 1024];
}

function checkLimits(width: number, height: number): void {
	const problems: string[] = [];
	const { edgeMultiple, maxEdge, maxRatio, minPixels, maxPixels } = SIZE_LIMITS;
	if (width % edgeMultiple !== 0 || height % edgeMultiple !== 0) problems.push(`both edges must be multiples of ${edgeMultiple}`);
	if (Math.max(width, height) > maxEdge) problems.push(`the long edge may be at most ${maxEdge}px`);
	if (Math.max(width / height, height / width) > maxRatio) problems.push(`the ratio may be at most ${maxRatio}:1`);
	const pixels = width * height;
	if (pixels < minPixels || pixels > maxPixels) {
		problems.push(`the total must be between ${minPixels.toLocaleString("en-US")} and ${maxPixels.toLocaleString("en-US")} pixels`);
	}
	if (problems.length > 0) {
		throw new ValidationError(
			`Size ${width}x${height} is not valid: ${problems.join("; ")}. ` +
				`Use a preset (${SIZE_PRESETS.join(", ")}) or an aspect_ratio instead.`,
		);
	}
}

/**
 * A sentence stating the wanted canvas, appended to the prompt.
 *
 * The ChatGPT backend picks the canvas from the prompt and does not reliably
 * follow the `size` field, so the shape is spelled out as well.
 */
export function sizeHint(resolved: ResolvedSize): string | undefined {
	if (!resolved.width || !resolved.height || !resolved.shape) return undefined;
	const detail = isPixelTarget(resolved)
		? `${resolved.width}x${resolved.height} pixels`
		: `${resolved.ratio ?? simplifyRatio(resolved.width, resolved.height)} aspect ratio`;
	return `Output format: ${resolved.shape} image, ${detail}.`;
}

/** How the caller asked, for messages: `21:9`, `ultrawide, 21:9`, `4k, 3840x2160`, `1536x1024`. */
export function describeRequest(resolved: ResolvedSize): string {
	if (resolved.kind === "auto") return "auto";
	if (resolved.kind === "ratio") return resolved.ratio ?? resolved.size;
	if (resolved.kind === "exact") return resolved.size;
	const preset = resolved.preset ?? "";
	return `${preset}, ${RATIO_PRESETS[preset] ?? resolved.size}`;
}

/** `16:9` → 1.778, `9:19.5` → 0.462. */
export function ratioValue(ratio: string): number | undefined {
	const match = RATIO.exec(ratio);
	if (!match) return undefined;
	const value = Number(match[1]) / Number(match[2]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function shapeOf(width: number, height: number): ImageShape {
	return width === height ? "square" : width > height ? "landscape" : "portrait";
}

export function megapixels(width: number, height: number): number {
	return Math.round((width * height) / 10_000) / 100;
}

function simplifyRatio(width: number, height: number): string {
	const divisor = gcd(width, height);
	return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}
