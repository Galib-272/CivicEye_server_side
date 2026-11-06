import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodBody, ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/auth.decorators';
import { ACCEPTED_CONTENT_TYPES, PHOTO_LIMITS } from './image-processing';
import { MediaService } from './media.service';

const uploadIntentSchema = z.strictObject({
  contentType: z.enum(ACCEPTED_CONTENT_TYPES),
  byteSize: z.number().int().min(1).max(PHOTO_LIMITS.maxBytes),
  /** WORK_PHOTO for an assigned worker's progress and completion photos. */
  purpose: z.enum(['REPORT_PHOTO', 'WORK_PHOTO']).default('REPORT_PHOTO'),
});

const uploadIntentResponseSchema = z.object({
  mediaId: z.uuid(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.object({ 'Content-Type': z.string() }),
  expiresAt: z.iso.datetime(),
});

export const mediaViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(['PENDING_UPLOAD', 'UPLOADED', 'PROCESSED', 'REJECTED']),
  rejectionReason: z.string().nullable(),
  displayUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});

const uuid = new ZodValidationPipe(z.uuid());

/** Photo uploads for reports and work. Uploading requires a verified email. */
@ApiTags('media')
@Controller({ path: 'media', version: '1' })
@RequirePermissions(Permission.ReportCreate)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-intent')
  @ApiOperation({
    summary: 'Get a 5-minute signed URL to upload one photo (JPEG, PNG or WebP, at most 10 MB).',
  })
  @ApiZodBody(uploadIntentSchema)
  @ApiZodResponse(uploadIntentResponseSchema, 201)
  @ApiErrorResponses(400, 403, 429)
  createIntent(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(uploadIntentSchema)) input: z.infer<typeof uploadIntentSchema>,
  ) {
    return this.media.createUploadIntent(
      auth.user.id,
      input.contentType,
      input.byteSize,
      input.purpose,
    );
  }

  @Post(':mediaId/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm the upload finished; the photo is then checked and processed.',
  })
  @ApiZodResponse(mediaViewSchema)
  @ApiErrorResponses(400, 404)
  confirm(@CurrentAuth() auth: AuthContext, @Param('mediaId', uuid) mediaId: string) {
    return this.media.confirmUpload(mediaId, auth.user.id);
  }

  @Get(':mediaId')
  @ApiOperation({ summary: 'Processing status and, when ready, short-lived image URLs.' })
  @ApiZodResponse(mediaViewSchema)
  @ApiErrorResponses(404)
  view(@CurrentAuth() auth: AuthContext, @Param('mediaId', uuid) mediaId: string) {
    return this.media.view(mediaId, auth.user.id);
  }

  @Delete(':mediaId')
  @ApiOperation({ summary: 'Remove a photo that is not yet part of a submitted report.' })
  @ApiZodResponse(z.object({ accepted: z.literal(true) }))
  @ApiErrorResponses(404, 409)
  async remove(@CurrentAuth() auth: AuthContext, @Param('mediaId', uuid) mediaId: string) {
    await this.media.remove(mediaId, auth.user.id);
    return { accepted: true as const };
  }
}
