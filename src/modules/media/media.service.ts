import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { AuthLimits, AuthRateLimiter } from '../auth/auth-rate-limiter.service';
import { SIGNED_URL_TTL_SECONDS, StorageService } from '../storage/storage.service';
import {
  ACCEPTED_CONTENT_TYPES,
  ImageRejectedError,
  PHOTO_LIMITS,
  processImage,
} from './image-processing';

export const MEDIA_QUEUE = Symbol('MEDIA_QUEUE');
export const MEDIA_QUEUE_NAME = 'media-processing';

export interface MediaView {
  id: string;
  status: 'PENDING_UPLOAD' | 'UPLOADED' | 'PROCESSED' | 'REJECTED';
  rejectionReason: string | null;
  displayUrl: string | null;
  thumbnailUrl: string | null;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly limiter: AuthRateLimiter,
    @Inject(MEDIA_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Step 1: authorizes one upload and returns a signed URL valid for 5 minutes. The object key
   * is random and server-generated; nothing from the client becomes part of a storage path.
   */
  async createUploadIntent(
    uploaderId: string,
    contentType: (typeof ACCEPTED_CONTENT_TYPES)[number],
    byteSize: number,
    purpose: 'REPORT_PHOTO' | 'WORK_PHOTO' = 'REPORT_PHOTO',
  ) {
    await this.limiter.consume(AuthLimits.mediaUploadsPerUser, uploaderId);
    const key = `uploads/${randomUUID()}`;
    const media = await this.prisma.reportMedia.create({
      data: {
        uploaderId,
        purpose,
        originalKey: key,
        declaredType: contentType,
        declaredBytes: byteSize,
      },
      select: { id: true },
    });
    return {
      mediaId: media.id,
      uploadUrl: await this.storage.presignUpload(key, contentType, byteSize),
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Step 2: the browser finished uploading; queue the photo for checks and processing. */
  async confirmUpload(mediaId: string, uploaderId: string): Promise<MediaView> {
    const media = await this.ownedMedia(mediaId, uploaderId);
    if (media.status === 'PENDING_UPLOAD') {
      const size = await this.storage.size(media.originalKey);
      if (size === null) {
        throw new AppException(ErrorCode.VALIDATION_ERROR, 'The file has not been uploaded yet.');
      }
      if (size > PHOTO_LIMITS.maxBytes) {
        await this.reject(media.id, media.originalKey, 'The file is larger than 10 MB.');
      } else {
        await this.prisma.reportMedia.update({
          where: { id: media.id },
          data: { status: 'UPLOADED' },
        });
        // jobId = media ID, so confirming twice never processes the photo twice.
        await this.queue.add('process', { mediaId: media.id }, { jobId: media.id });
      }
    }
    return this.view(mediaId, uploaderId);
  }

  /** Background step: validate by content, strip all metadata, store clean renditions. */
  async process(mediaId: string): Promise<void> {
    const media = await this.prisma.reportMedia.findUnique({ where: { id: mediaId } });
    if (!media || media.status !== 'UPLOADED') return; // Already handled (idempotent).

    let input: Buffer;
    try {
      input = await this.storage.read(media.originalKey, PHOTO_LIMITS.maxBytes);
    } catch {
      await this.reject(media.id, media.originalKey, 'The file could not be read or is too large.');
      return;
    }

    try {
      const image = await processImage(input);
      const displayKey = `media/${media.id}/display.jpg`;
      const thumbnailKey = `media/${media.id}/thumbnail.jpg`;
      await this.storage.write(displayKey, image.display, 'image/jpeg');
      await this.storage.write(thumbnailKey, image.thumbnail, 'image/jpeg');
      await this.prisma.reportMedia.update({
        where: { id: media.id },
        data: {
          status: 'PROCESSED',
          displayKey,
          thumbnailKey,
          detectedFormat: image.format,
          width: image.width,
          height: image.height,
          sha256: image.sha256,
          processedAt: new Date(),
        },
      });
      // The upload may contain GPS and other metadata; only the clean renditions are kept.
      await this.storage.remove(media.originalKey);
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        await this.reject(media.id, media.originalKey, error.message);
        return;
      }
      throw error; // Transient (e.g. storage) failure: let the queue retry.
    }
  }

  /** Status and, once processed, short-lived signed URLs. Visible to the uploader only. */
  async view(mediaId: string, uploaderId: string): Promise<MediaView> {
    const media = await this.ownedMedia(mediaId, uploaderId);
    return this.toView(media);
  }

  async toView(media: {
    id: string;
    status: MediaView['status'];
    rejectionReason: string | null;
    displayKey: string | null;
    thumbnailKey: string | null;
  }): Promise<MediaView> {
    const processed = media.status === 'PROCESSED';
    return {
      id: media.id,
      status: media.status,
      rejectionReason: media.rejectionReason,
      displayUrl:
        processed && media.displayKey ? await this.storage.presignDownload(media.displayKey) : null,
      thumbnailUrl:
        processed && media.thumbnailKey
          ? await this.storage.presignDownload(media.thumbnailKey)
          : null,
    };
  }

  /** Removes a photo that has not been attached to a report or a work update yet. */
  async remove(mediaId: string, uploaderId: string): Promise<void> {
    const media = await this.ownedMedia(mediaId, uploaderId);
    if (media.reportId || media.assignmentId) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Photos that are already in use cannot be removed.',
      );
    }
    await this.prisma.reportMedia.delete({ where: { id: media.id } });
    await Promise.all(
      [media.originalKey, media.displayKey, media.thumbnailKey]
        .filter((key): key is string => !!key)
        .map((key) =>
          this.storage
            .remove(key)
            .catch((error: unknown) => this.logger.warn({ err: error }, 'Could not delete object')),
        ),
    );
  }

  private async ownedMedia(mediaId: string, uploaderId: string) {
    const media = await this.prisma.reportMedia.findFirst({ where: { id: mediaId, uploaderId } });
    // Another user's media looks exactly like a missing one.
    if (!media) throw new AppException(ErrorCode.NOT_FOUND);
    return media;
  }

  private async reject(mediaId: string, key: string, reason: string): Promise<void> {
    await this.prisma.reportMedia.update({
      where: { id: mediaId },
      data: { status: 'REJECTED', rejectionReason: reason, processedAt: new Date() },
    });
    await this.storage
      .remove(key)
      .catch((error: unknown) =>
        this.logger.warn({ err: error }, 'Could not delete rejected upload'),
      );
  }
}
