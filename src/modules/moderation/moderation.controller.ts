import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
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
import { publicIdSchema } from '../reports/reports.schemas';
import {
  actionSchema,
  caseDetailSchema,
  caseListItemSchema,
  caseQuerySchema,
  escalateSchema,
  flagResultSchema,
  flagSchema,
  type ActionInput,
  type CaseQuery,
  type EscalateInput,
  type FlagInput,
} from './moderation.schemas';
import { ModerationService } from './moderation.service';

const uuid = new ZodValidationPipe(z.uuid());
const publicId = new ZodValidationPipe(publicIdSchema);

/** Flagging public content. Needs a signed-in account with a verified email address. */
@ApiTags('moderation')
@Controller({ path: 'reports', version: '1' })
@RequirePermissions(Permission.CommentCreate)
export class FlagsController {
  constructor(private readonly moderation: ModerationService) {}

  @Post(':publicId/flags')
  @HttpCode(201)
  @ApiOperation({ summary: 'Report a problem with a public report (not your own).' })
  @ApiZodBody(flagSchema)
  @ApiZodResponse(flagResultSchema, 201)
  @ApiErrorResponses(400, 404, 409, 429)
  flagReport(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(flagSchema)) input: FlagInput,
    @Req() request: Request,
  ) {
    return this.moderation.flag(id, null, input, auth.user.id, request);
  }

  @Post(':publicId/updates/:updateId/flags')
  @HttpCode(201)
  @ApiOperation({ summary: 'Report a problem with an organization’s public update.' })
  @ApiZodBody(flagSchema)
  @ApiZodResponse(flagResultSchema, 201)
  @ApiErrorResponses(400, 404, 409, 429)
  flagUpdate(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Param('updateId', uuid) updateId: string,
    @Body(new ZodValidationPipe(flagSchema)) input: FlagInput,
    @Req() request: Request,
  ) {
    return this.moderation.flag(id, updateId, input, auth.user.id, request);
  }
}

/** An organization asks the Super Admins to review a report it handles. */
@ApiTags('organization reports')
@Controller({ path: 'organizations/:organizationId/reports', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class EscalationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post(':publicId/escalate')
  @HttpCode(201)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Escalate a report to the Super Admins for moderation, with details.' })
  @ApiZodBody(escalateSchema)
  @ApiZodResponse(flagResultSchema, 201)
  @ApiErrorResponses(400, 404, 409)
  escalate(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(escalateSchema)) input: EscalateInput,
    @Req() request: Request,
  ) {
    return this.moderation.escalate(organizationId, id, input, auth.user.id, request);
  }
}

/** The moderation queue and decisions (Super Admins). */
@ApiTags('admin')
@Controller({ path: 'admin/moderation/cases', version: '1' })
@RequirePermissions(Permission.AdminModerationManage)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get()
  @ApiOperation({ summary: 'Moderation cases: escalated first, then most flagged, then oldest.' })
  @ApiZodQuery(caseQuerySchema)
  @ApiZodPaginatedResponse(caseListItemSchema)
  list(@Query(new ZodValidationPipe(caseQuerySchema)) query: CaseQuery) {
    return this.moderation.list(query);
  }

  @Get(':caseId')
  @ApiOperation({
    summary: 'One case: the content, every flag, every decision, what is possible now.',
  })
  @ApiZodResponse(caseDetailSchema)
  @ApiErrorResponses(404)
  detail(@Param('caseId', uuid) caseId: string) {
    return this.moderation.detail(caseId);
  }

  @Post(':caseId/actions')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Decide: review, hide, restore, ask for a correction, warn, suspend, resolve or dismiss.',
  })
  @ApiZodBody(actionSchema)
  @ApiZodResponse(caseDetailSchema)
  @ApiErrorResponses(400, 403, 404, 409)
  act(
    @CurrentAuth() auth: AuthContext,
    @Param('caseId', uuid) caseId: string,
    @Body(new ZodValidationPipe(actionSchema)) input: ActionInput,
    @Req() request: Request,
  ) {
    return this.moderation.act(caseId, input, auth.user.id, request);
  }
}
