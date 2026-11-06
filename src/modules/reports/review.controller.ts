import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ApiErrorResponses } from '../../common/http/openapi';
import {
  ApiZodBody,
  ApiZodPaginatedResponse,
  ApiZodQuery,
  ApiZodResponse,
} from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { OrganizationPermission, Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import {
  CurrentAuth,
  RequireOrganizationPermission,
  RequirePermissions,
} from '../auth/auth.decorators';
import { publicIdSchema } from './reports.schemas';
import {
  acceptSchema,
  hideUpdateSchema,
  internalNoteSchema,
  noteInputSchema,
  organizationHistoryEntrySchema,
  organizationReportSchema,
  organizationUpdateSchema,
  queueCountsSchema,
  queueItemSchema,
  queueQuerySchema,
  rejectSchema,
  requestInformationSchema,
  transferSchema,
  transferTargetSchema,
  updateInputSchema,
  type AcceptInput,
  type QueueQuery,
  type RejectInput,
  type TransferInput,
} from './review.schemas';
import { ReviewService } from './review.service';

const uuid = new ZodValidationPipe(z.uuid());
const publicId = new ZodValidationPipe(publicIdSchema);

/** Reads the report version from If-Match; review actions on a stale version are refused. */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined) throw new AppException(ErrorCode.PRECONDITION_REQUIRED);
  const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(version) || version < 1) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'If-Match must be the report version number.',
    );
  }
  return version;
}

const ifMatchHeader = {
  name: 'If-Match',
  required: true,
  description: 'The report version the reviewer is looking at',
} as const;

/**
 * Review workspace for one organization. Every route needs an ACTIVE Org Admin or Reviewer
 * membership in :organizationId (others get NOT_FOUND), and only reports currently handled by
 * that organization are reachable.
 */
@ApiTags('organization reports')
@Controller({ path: 'organizations/:organizationId/reports', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class OrganizationReportsController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Review queue, oldest first.' })
  @ApiZodQuery(queueQuerySchema)
  @ApiZodPaginatedResponse(queueItemSchema)
  @ApiErrorResponses(400, 404)
  queue(
    @Param('organizationId', uuid) organizationId: string,
    @Query(new ZodValidationPipe(queueQuerySchema)) query: QueueQuery,
  ) {
    return this.review.queue(organizationId, query);
  }

  @Get('counts')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Number of reports in each queue tab.' })
  @ApiZodResponse(queueCountsSchema)
  @ApiErrorResponses(404)
  counts(@Param('organizationId', uuid) organizationId: string) {
    return this.review.queueCounts(organizationId);
  }

  @Get(':publicId')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'A report in the review workspace. The reporter is never shown.' })
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(404)
  get(
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
  ) {
    return this.review.view(id, { kind: 'organization', organizationId });
  }

  @Get(':publicId/history')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Full status timeline with reasons.' })
  @ApiZodResponse(z.array(organizationHistoryEntrySchema))
  @ApiErrorResponses(404)
  history(
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
  ) {
    return this.review.history(id, { kind: 'organization', organizationId });
  }

  @Post(':publicId/start-review')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'SUBMITTED → UNDER_REVIEW.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(404, 409, 422, 428)
  startReview(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
  ) {
    return this.review.startReview(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      auth.user.id,
      request,
    );
  }

  @Post(':publicId/request-information')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'UNDER_REVIEW → NEEDS_INFORMATION, with a message to the citizen.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(requestInformationSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  requestInformation(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(requestInformationSchema)) input: { message: string },
    @Req() request: Request,
  ) {
    return this.review.requestInformation(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input.message,
      auth.user.id,
      request,
    );
  }

  @Post(':publicId/accept')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({
    summary: 'UNDER_REVIEW → ACCEPTED. The category must be one the organization handles.',
  })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(acceptSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(acceptSchema)) input: AcceptInput,
    @Req() request: Request,
  ) {
    return this.review.accept(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input,
      auth.user.id,
      request,
    );
  }

  @Post(':publicId/reject')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'UNDER_REVIEW → REJECTED, with a reason and a message to the citizen.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(rejectSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(rejectSchema)) input: RejectInput,
    @Req() request: Request,
  ) {
    return this.review.reject(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input,
      auth.user.id,
      request,
    );
  }

  @Get(':publicId/transfer-targets')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Organizations that may receive this report in a transfer.' })
  @ApiZodResponse(z.array(transferTargetSchema))
  @ApiErrorResponses(404)
  transferTargets(
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
  ) {
    return this.review.transferTargets(organizationId, id);
  }

  @Post(':publicId/transfer')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({
    summary:
      'Move the report to another eligible organization, or back to Super Admin triage (toOrganizationId null). Your organization loses access.',
  })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(transferSchema)
  @ApiZodResponse(z.object({ transferred: z.literal(true) }))
  @ApiErrorResponses(400, 404, 409, 422, 428)
  async transfer(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(transferSchema)) input: TransferInput,
    @Req() request: Request,
  ) {
    await this.review.transfer(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input,
      auth.user.id,
      request,
    );
    return { transferred: true as const };
  }

  @Get(':publicId/notes')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Internal notes of this organization. Never shown to citizens.' })
  @ApiZodResponse(z.array(internalNoteSchema))
  @ApiErrorResponses(404)
  notes(
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
  ) {
    return this.review.notes(id, { kind: 'organization', organizationId });
  }

  @Post(':publicId/notes')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Add an internal note. Notes cannot be edited or deleted.' })
  @ApiZodBody(noteInputSchema)
  @ApiZodResponse(z.array(internalNoteSchema), 201)
  @ApiErrorResponses(400, 404)
  addNote(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(noteInputSchema)) input: { body: string },
  ) {
    return this.review.addNote(organizationId, id, input.body, auth.user.id);
  }

  @Get(':publicId/updates')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Public updates on the report, including hidden ones.' })
  @ApiZodResponse(z.array(organizationUpdateSchema))
  @ApiErrorResponses(404)
  updates(
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
  ) {
    return this.review.updates(id, { kind: 'organization', organizationId });
  }

  @Post(':publicId/updates')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Post a public update, shown to everyone who can see the report.' })
  @ApiZodBody(updateInputSchema)
  @ApiZodResponse(z.array(organizationUpdateSchema), 201)
  @ApiErrorResponses(400, 404)
  addUpdate(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(updateInputSchema)) input: { body: string },
    @Req() request: Request,
  ) {
    return this.review.addUpdate(organizationId, id, input.body, auth.user.id, request);
  }
}

/** Super Admin oversight of any report: audited viewing and moderation of public updates. */
@ApiTags('admin')
@Controller({ path: 'admin/reports', version: '1' })
@RequirePermissions(Permission.AdminReportsManage)
export class AdminReportModerationController {
  constructor(private readonly review: ReviewService) {}

  @Get(':publicId')
  @ApiOperation({ summary: 'Any report in the workspace view. Each view is audited.' })
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(404)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Req() request: Request,
  ) {
    return this.review.adminView(id, auth.user.id, request);
  }

  @Get(':publicId/history')
  @ApiOperation({ summary: 'Full status timeline with reasons.' })
  @ApiZodResponse(z.array(organizationHistoryEntrySchema))
  @ApiErrorResponses(404)
  history(@Param('publicId', publicId) id: string) {
    return this.review.history(id, { kind: 'super_admin' });
  }

  @Get(':publicId/notes')
  @ApiOperation({ summary: 'Internal notes of every organization that handled the report.' })
  @ApiZodResponse(z.array(internalNoteSchema))
  @ApiErrorResponses(404)
  notes(@Param('publicId', publicId) id: string) {
    return this.review.notes(id, { kind: 'super_admin' });
  }

  @Get(':publicId/updates')
  @ApiOperation({ summary: 'Public updates, including hidden ones.' })
  @ApiZodResponse(z.array(organizationUpdateSchema))
  @ApiErrorResponses(404)
  updates(@Param('publicId', publicId) id: string) {
    return this.review.updates(id, { kind: 'super_admin' });
  }

  @Post('updates/:updateId/hide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hide an abusive public update, with a reason.' })
  @ApiZodBody(hideUpdateSchema)
  @ApiZodResponse(z.object({ hidden: z.literal(true) }))
  @ApiErrorResponses(400, 404)
  async hide(
    @CurrentAuth() auth: AuthContext,
    @Param('updateId', uuid) updateId: string,
    @Body(new ZodValidationPipe(hideUpdateSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    await this.review.hideUpdate(updateId, input.reason, auth.user.id, request);
    return { hidden: true as const };
  }
}
