import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** Approved photo limits (Phase 4). */
export const PHOTO_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPerReport: 5,
  /** Rejects decompression bombs before decoding: 50 megapixels. */
  maxPixels: 50_000_000,
  minDimension: 200,
} as const;

/**
 * Formats accepted from browsers. HEIC is not decodable here (HEVC is not included in the
 * image library for patent reasons); iPhones convert HEIC to JPEG when a page asks for these
 * types, so iPhone photos still arrive as JPEG.
 */
export const ACCEPTED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export class ImageRejectedError extends Error {}

export interface ProcessedImage {
  format: string;
  width: number;
  height: number;
  sha256: string;
  display: Buffer;
  thumbnail: Buffer;
}

/**
 * Validates an uploaded image by its actual content (never its name or declared type) and
 * produces clean JPEG renditions. Re-encoding drops every piece of metadata, including EXIF
 * GPS coordinates, camera details and embedded thumbnails; orientation is applied first so
 * photos still display upright.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: PHOTO_LIMITS.maxPixels }).metadata();
  } catch {
    throw new ImageRejectedError('The file is not a readable image.');
  }
  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
    throw new ImageRejectedError('Only JPEG, PNG and WebP photos are accepted.');
  }
  const { width = 0, height = 0 } = metadata;
  if (Math.min(width, height) < PHOTO_LIMITS.minDimension) {
    throw new ImageRejectedError(
      `The photo is too small; it must be at least ${PHOTO_LIMITS.minDimension} pixels on each side.`,
    );
  }

  const render = (size: number, quality: number) =>
    sharp(input, { limitInputPixels: PHOTO_LIMITS.maxPixels, failOn: 'error' })
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

  try {
    const [display, thumbnail] = await Promise.all([render(1600, 82), render(400, 75)]);
    return {
      format: metadata.format,
      width,
      height,
      sha256: createHash('sha256').update(input).digest('hex'),
      display,
      thumbnail,
    };
  } catch {
    throw new ImageRejectedError('The image is damaged or could not be processed.');
  }
}
