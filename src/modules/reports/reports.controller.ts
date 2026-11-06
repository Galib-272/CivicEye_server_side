import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, Public, RequirePermissions } from '../auth/auth.decorators';
import { IdempotencyService } from './idempotency.service';
import { parseIfMatch } from './review.controller';
import {
  createReportSchema,
  historyEntrySchema,
  myReportsQuerySchema,
  myReportsSummarySchema,
  ownReportSchema,
  provideInformationSchema,
  publicIdSchema,
  publicUpdateSchema,
  publicReportSchema,
  publicReportsQuerySchema,
  routeReportSchema,
  triageItemSchema,
  triageQuerySchema,
  updateReportSchema,
  withdrawSchema,
  type CreateReportInput,
  type ProvideInformationInput,
  type PublicReportsQuery,
  type UpdateReportInput,
} from './reports.schemas';
import { ReportsService } from './reports.service';

const publicId = new ZodValidationPipe(publicIdSchema);
const reportViewSchema = z.union([ownReportSchema, publicReportSchema]);

@ApiTags('reports')
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Public reports. Locations are rounded and reporters are never shown.' })
  @ApiZodQuery(publicReportsQuerySchema)
  @ApiZodPaginatedResponse(publicReportSchema)
  @ApiErrorResponses(400)
  list(@Query(new ZodValidationPipe(publicReportsQuerySchema)) query: PublicReportsQuery) {
    return this.reports.publicList(query);
  }

  @Post()
  @RequirePermissions(Permission.ReportCreate)
  @ApiOperation({
    summary:
      'Submit a report with 1–5 processed photos. Repeating the Idempotency-Key returns the same report.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiZodBody(createReportSchema)
  @ApiZodResponse(ownReportSchema, 201)
  @ApiErrorResponses(400, 403, 409, 429)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createReportSchema)) input: CreateReportInput,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ) {
    const { publicId: id } = await this.idempotency.run(
      auth.user.id,
      'POST /reports',
      key,
      input,
      async () => ({
        publicId: await this.reports.create(input, auth.user, request),
      }),
    );
    return (await this.reports.findForViewer(id, auth.user)).report;
  }

  @Get('mine')
  @RequirePermissions(Permission.AccountSelf)
  @ApiOperation({ summary: 'The signed-in citizen’s reports, newest first.' })
  @ApiZodQuery(myReportsQuerySchema)
  @ApiZodPaginatedResponse(publicReportSchema)
  mine(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(myReportsQuerySchema)) query: z.infer<typeof myReportsQuerySchema>,
  ) {
    return this.reports.mine(auth.user.id, query);
  }

  @Get('mine/summary')
  @RequirePermissions(Permission.AccountSelf)
  @ApiOperation({ summary: 'Counts of the signed-in citizen’s reports by status.' })
  @ApiZodResponse(myReportsSummarySchema)
  summary(@CurrentAuth() auth: AuthContext) {
    return this.reports.mySummary(auth.user.id);
  }

  @Get(':publicId')
  @Public()
  @ApiOperation({
    summary:
      'A report: the full view for its citizen, otherwise the public view of a public report.',
  })
  @ApiZodResponse(reportViewSchema)
  @ApiErrorResponses(404)
  async get(@Param('publicId', publicId) id: string, @Req() request: Request) {
    return (await this.reports.findForViewer(id, request.auth?.user)).report;
  }

  @Get(':publicId/history')
  @Public()
  @ApiOperation({ summary: 'Status timeline. Reasons are shown only to the reporting citizen.' })
  @ApiZodResponse(z.array(historyEntrySchema))
  @ApiErrorResponses(404)
  history(@Param('publicId', publicId) id: string, @Req() request: Request) {
    return this.reports.history(id, request.auth?.user);
  }

  @Get(':publicId/updates')
  @Public()
  @ApiOperation({ summary: 'Organization updates on a report you may see.' })
  @ApiZodResponse(z.array(publicUpdateSchema))
  @ApiErrorResponses(404)
  updates(@Param('publicId', publicId) id: string, @Req() request: Request) {
    return this.reports.publicUpdates(id, request.auth?.user);
  }

  @Post(':publicId/additional-information')
  @RequirePermissions(Permission.ReportCreate)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Answer the organization’s information request (NEEDS_INFORMATION → UNDER_REVIEW), optionally with more photos.',
  })
  @ApiZodBody(provideInformationSchema)
  @ApiZodResponse(ownReportSchema)
  @ApiErrorResponses(400, 403, 404, 422)
  provideInformation(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(provideInformationSchema)) input: ProvideInformationInput,
    @Req() request: Request,
  ) {
    return this.reports.provideInformation(id, input, auth.user, request);
  }

  @Patch(':publicId')
  @RequirePermissions(Permission.AccountSelf)
  @ApiOperation({
    summary: 'Edit your report while it is SUBMITTED. Send If-Match with the current version.',
  })
  @ApiHeader({ name: 'If-Match', required: true, description: 'The report version being edited' })
  @ApiZodBody(updateReportSchema)
  @ApiZodResponse(ownReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(updateReportSchema)) input: UpdateReportInput,
    @Req() request: Request,
  ) {
    return this.reports.update(id, input, parseIfMatch(ifMatch), auth.user, request);
  }

  @Post(':publicId/withdraw')
  @RequirePermissions(Permission.AccountSelf)
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw your report while it is SUBMITTED or NEEDS_INFORMATION.' })
  @ApiZodBody(withdrawSchema)
  @ApiZodResponse(ownReportSchema)
  @ApiErrorResponses(400, 404, 422)
  withdraw(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(withdrawSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.reports.withdraw(id, input.reason, auth.user, request);
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/reports', version: '1' })
@RequirePermissions(Permission.AdminReportsTriage)
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('triage')
  @ApiOperation({ summary: 'Reports no single organization covers, oldest first (Super Admin).' })
  @ApiZodQuery(triageQuerySchema)
  @ApiZodPaginatedResponse(triageItemSchema)
  triage(
    @Query(new ZodValidationPipe(triageQuerySchema)) query: z.infer<typeof triageQuerySchema>,
  ) {
    return this.reports.triage(query);
  }

  @Post(':publicId/route')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a triaged report to a verified organization, with a reason.' })
  @ApiZodBody(routeReportSchema)
  @ApiZodResponse(z.object({ accepted: z.literal(true) }))
  @ApiErrorResponses(400, 404, 422)
  async route(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(routeReportSchema)) input: z.infer<typeof routeReportSchema>,
    @Req() request: Request,
  ) {
    await this.reports.routeManually(id, input.organizationId, input.reason, auth.user.id, request);
    return { accepted: true as const };
  }
}
