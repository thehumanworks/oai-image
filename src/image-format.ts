/** Image container detection and dimension reading, from magic bytes alone. */

export interface ImageFormat {
	mimeType: string;
	extension: string;
}

const FORMATS = {
	png: { mimeType: "image/png", extension: "png" },
	jpeg: { mimeType: "image/jpeg", extension: "jpg" },
	gif: { mimeType: "image/gif", extension: "gif" },
	webp: { mimeType: "image/webp", extension: "webp" },
	svg: { mimeType: "image/svg+xml", extension: "svg" },
} as const satisfies Record<string, ImageFormat>;

const EXTENSION_FORMATS: Readonly<Record<string, ImageFormat>> = {
	png: FORMATS.png,
	jpg: FORMATS.jpeg,
	jpeg: FORMATS.jpeg,
	gif: FORMATS.gif,
	webp: FORMATS.webp,
	svg: FORMATS.svg,
};

/** Identify an image from its first bytes. Returns undefined for anything unrecognized. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return FORMATS.png;
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return FORMATS.jpeg;
	if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return FORMATS.gif;
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return FORMATS.webp;
	const head = Buffer.from(bytes.subarray(0, 1024)).toString("utf8").replace(/^﻿/, "").trimStart();
	if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return FORMATS.svg;
	return undefined;
}

export function formatFromExtension(file: string): ImageFormat | undefined {
	const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
	return extension ? EXTENSION_FORMATS[extension] : undefined;
}

/** Pixel dimensions of a PNG, JPEG, GIF or WebP. Returns undefined when they cannot be read. */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	const format = sniffImageFormat(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	try {
		switch (format) {
			case FORMATS.png:
				return positive(view.getUint32(16), view.getUint32(20));
			case FORMATS.gif:
				return positive(view.getUint16(6, true), view.getUint16(8, true));
			case FORMATS.jpeg:
				return jpegSize(view);
			case FORMATS.webp:
				return webpSize(bytes, view);
			default:
				return undefined;
		}
	} catch {
		// A truncated file reads past the end of the view.
		return undefined;
	}
}

function jpegSize(view: DataView): { width: number; height: number } | undefined {
	let offset = 2;
	while (offset + 9 < view.byteLength) {
		if (view.getUint8(offset) !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = view.getUint8(offset + 1);
		// Padding and markers without a length field.
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			offset += 2;
			continue;
		}
		// Start-of-frame markers carry the dimensions; C4, C8 and CC are not frames.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return positive(view.getUint16(offset + 7), view.getUint16(offset + 5));
		}
		offset += 2 + view.getUint16(offset + 2);
	}
	return undefined;
}

function webpSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | undefined {
	const chunk = ascii(bytes, 12, 16);
	if (chunk === "VP8X") {
		return positive(1 + uint24le(view, 24), 1 + uint24le(view, 27));
	}
	if (chunk === "VP8L") {
		const bits = view.getUint32(21, true);
		return positive(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
	}
	if (chunk === "VP8 ") {
		return positive(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
	}
	return undefined;
}

function uint24le(view: DataView, offset: number): number {
	return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

function positive(width: number, height: number): { width: number; height: number } | undefined {
	return width > 0 && height > 0 ? { width, height } : undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return bytes.length >= end ? String.fromCharCode(...bytes.subarray(start, end)) : "";
}
