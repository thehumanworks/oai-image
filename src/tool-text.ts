/**
 * Tool descriptions shared by the local and the hosted MCP server, so agents
 * get the same limits and caveats from both.
 */
import { SIZE_PRESETS } from "./size.ts";

/** Accepted `size` values; case-insensitive in the SDK, lower case here so the JSON Schema stays simple. */
export const SIZE_PATTERN = new RegExp(`^(auto|${SIZE_PRESETS.join("|")}|\\d{2,5}x\\d{2,5})$`);
/** Accepted `aspect_ratio` values. */
export const RATIO_PATTERN = /^\d+(\.\d+)?:\d+(\.\d+)?$/;

export const SIZE_DESCRIPTION =
	'Canvas: "auto" (default), a preset, or WIDTHxHEIGHT. Presets: "square" (1024x1024), "landscape" (1536x1024), ' +
	'"portrait" (1024x1536), "phone" (9:19.5), "ultrawide" (21:9), "widescreen" (16:9), "story" (9:16), "2k" (2048x2048), "4k" (3840x2160). ' +
	"WIDTHxHEIGHT needs both edges multiples of 16, long edge at most 3840, ratio at most 3:1, 655,360 to 8,294,400 pixels. " +
	"This is a request, not a guarantee: the service has so far returned about 1.57 megapixels whatever was asked, " +
	"so 2k, 4k and large custom sizes usually come back smaller. The result reports requested and actual size and warns on any difference.";

export const RATIO_DESCRIPTION =
	'Aspect ratio WIDTH:HEIGHT instead of size, from 1:3 to 3:1, e.g. "16:9", "21:9", "9:19.5". ' +
	"Rendered at about 1.57 megapixels; the result warns if the returned ratio is more than 3% off.";

export const QUALITY_DESCRIPTION =
	"Rendering quality: more detail and slower at higher levels, and more of the plan's limit. It does not change the pixel size.";

export const SIZING_INSTRUCTIONS = `About sizes: size and aspect_ratio are requests. Each result reports sizing.requested, sizing.sent and sizing.actual, and lists warnings with a code (ratio_snapped, size_reduced, size_changed, shape_changed) when the image differs from what was asked. Expect about 1.57 megapixels per image at any quality.
Run one image at a time per account. Parallel calls are more likely to be blocked by ChatGPT's edge protection.
Failures carry an error code and a retryable flag: upstream_blocked and rate_limited are safe to retry after retry_after_seconds; usage_limit is not.`;
