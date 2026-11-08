import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodBody, ApiZodResponse } from '../../common/http/zod-openapi';
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
  aiReportViewSchema,
  aiReviewSchema,
  aiStatusSchema,
  type AiReviewInput,
} from './ai.schemas';
import { AiService } from './ai.service';

const uuid = new ZodValidationPipe(z.uuid());
const publicId = new ZodValidationPipe(publicIdSchema);
const reviewBody = new ZodValidationPipe(aiReviewSchema);

/** AI suggestions for an organization's reviewers (Org Admin or Reviewer of :organizationId). */
@ApiTags('organization reports')
@Controller({ path: 'organizations/:organizationId/reports', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class OrganizationAiController {
  constructor(private readonly ai: AiService) {}

  @Get(':publicId/ai')
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Advisory AI analysis of each photo (latest per photo).' })
  @ApiZodResponse(aiReportViewSchema)
  @ApiErrorResponses(404)
  view(
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
  ) {
    return this.ai.forReport({ organizationId }, id);
  }

  @Post(':publicId/ai/:predictionId/review')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'Accept, correct or dismiss an AI suggestion (recorded once).' })
  @ApiZodBody(aiReviewSchema)
  @ApiZodResponse(aiReportViewSchema)
  @ApiErrorResponses(400, 404, 409)
  review(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Param('predictionId', uuid) predictionId: string,
    @Body(reviewBody) input: AiReviewInput,
    @Req() request: Request,
  ) {
    return this.ai.review({ organizationId }, id, predictionId, input, auth.user.id, request);
  }
}

/** AI suggestions for Super Admins handling triage, and AI monitoring. */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminAiController {
  constructor(private readonly ai: AiService) {}

  @Get('reports/:publicId/ai')
  @RequirePermissions(Permission.AdminReportsTriage)
  @ApiOperation({ summary: 'Advisory AI analysis of each photo of any report (Super Admin).' })
  @ApiZodResponse(aiReportViewSchema)
  @ApiErrorResponses(404)
  view(@Param('publicId', publicId) id: string) {
    return this.ai.forReport({ admin: true }, id);
  }

  @Post('reports/:publicId/ai/:predictionId/review')
  @HttpCode(200)
  @RequirePermissions(Permission.AdminReportsTriage)
  @ApiOperation({ summary: 'Accept, correct or dismiss an AI suggestion (Super Admin).' })
  @ApiZodBody(aiReviewSchema)
  @ApiZodResponse(aiReportViewSchema)
  @ApiErrorResponses(400, 404, 409)
  review(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Param('predictionId', uuid) predictionId: string,
    @Body(reviewBody) input: AiReviewInput,
    @Req() request: Request,
  ) {
    return this.ai.review({ admin: true }, id, predictionId, input, auth.user.id, request);
  }

  @Get('ai/status')
  @RequirePermissions(Permission.AdminReportsManage)
  @ApiOperation({ summary: 'AI switch, service model version and the last 7 days of results.' })
  @ApiZodResponse(aiStatusSchema)
  status() {
    return this.ai.status();
  }
}
