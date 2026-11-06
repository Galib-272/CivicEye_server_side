import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
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
import { OrganizationPermission, Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import {
  CurrentAuth,
  RequireOrganizationPermission,
  RequirePermissions,
} from '../auth/auth.decorators';
import { ownReportSchema, publicIdSchema } from './reports.schemas';
import { parseIfMatch } from './review.controller';
import { organizationReportSchema } from './review.schemas';
import {
  assignSchema,
  availabilitySchema,
  completeSchema,
  feedbackSchema,
  progressSchema,
  reassignSchema,
  reasonSchema,
  taskItemSchema,
  taskSchema,
  tasksQuerySchema,
  verifySchema,
  workerSchema,
  workMembershipSchema,
  type AssignInput,
  type CompleteInput,
  type FeedbackInput,
  type ProgressInput,
  type ReassignInput,
  type TasksQuery,
  type VerifyInput,
} from './work.schemas';
import { WorkService } from './work.service';

const uuid = new ZodValidationPipe(z.uuid());
const publicId = new ZodValidationPipe(publicIdSchema);
const ifMatchHeader = {
  name: 'If-Match',
  required: true,
  description: 'The report version the reviewer is looking at',
} as const;

/** The signed-in worker's own tasks. Only assignments in organizations they still work for. */
@ApiTags('work')
@Controller({ path: 'work', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class WorkController {
  constructor(private readonly work: WorkService) {}

  @Get('memberships')
  @ApiOperation({ summary: 'Organizations where you are a worker, with your availability.' })
  @ApiZodResponse(z.array(workMembershipSchema))
  memberships(@CurrentAuth() auth: AuthContext) {
    return this.work.memberships(auth.user.id);
  }

  @Put('memberships/:organizationId/availability')
  @ApiOperation({ summary: 'Mark yourself available or unavailable for new tasks.' })
  @ApiZodBody(availabilitySchema)
  @ApiZodResponse(z.array(workMembershipSchema))
  @ApiErrorResponses(400, 404)
  availability(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(availabilitySchema)) input: { available: boolean },
  ) {
    return this.work.setAvailability(auth.user.id, organizationId, input.available);
  }

  @Get('tasks')
  @ApiOperation({ summary: 'Your tasks in one group, oldest first.' })
  @ApiZodQuery(tasksQuerySchema)
  @ApiZodPaginatedResponse(taskItemSchema)
  tasks(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(tasksQuerySchema)) query: TasksQuery,
  ) {
    return this.work.tasks(auth.user.id, query);
  }

  @Get('tasks/:assignmentId')
  @ApiOperation({ summary: 'One of your tasks. The reporter is never shown.' })
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(404)
  task(@CurrentAuth() auth: AuthContext, @Param('assignmentId', uuid) id: string) {
    return this.work.task(auth.user.id, id);
  }

  @Post('tasks/:assignmentId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept the task.' })
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(404, 422)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('assignmentId', uuid) id: string,
    @Req() request: Request,
  ) {
    return this.work.accept(auth.user, id, request);
  }

  @Post('tasks/:assignmentId/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline the task before starting, with a reason.' })
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(400, 404, 422)
  decline(
    @CurrentAuth() auth: AuthContext,
    @Param('assignmentId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.work.decline(auth.user, id, input.reason, request);
  }

  @Post('tasks/:assignmentId/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start work (ASSIGNED → IN_PROGRESS).' })
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(404, 422)
  start(
    @CurrentAuth() auth: AuthContext,
    @Param('assignmentId', uuid) id: string,
    @Req() request: Request,
  ) {
    return this.work.start(auth.user, id, request);
  }

  @Post('tasks/:assignmentId/progress')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add a progress note, optionally with photos (purpose WORK_PHOTO).' })
  @ApiZodBody(progressSchema)
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(400, 404, 422)
  progress(
    @CurrentAuth() auth: AuthContext,
    @Param('assignmentId', uuid) id: string,
    @Body(new ZodValidationPipe(progressSchema)) input: ProgressInput,
  ) {
    return this.work.progress(auth.user, id, input);
  }

  @Post('tasks/:assignmentId/return')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hand the task back (unsafe, inaccessible, partly done), with a reason.',
  })
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(400, 404, 422)
  returnTask(
    @CurrentAuth() auth: AuthContext,
    @Param('assignmentId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.work.returnTask(auth.user, id, input.reason, request);
  }

  @Post('tasks/:assignmentId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit completion evidence (description and 1–5 after photos) for verification.',
  })
  @ApiZodBody(completeSchema)
  @ApiZodResponse(taskSchema)
  @ApiErrorResponses(400, 404, 422)
  complete(
    @CurrentAuth() auth: AuthContext,
    @Param('assignmentId', uuid) id: string,
    @Body(new ZodValidationPipe(completeSchema)) input: CompleteInput,
    @Req() request: Request,
  ) {
    return this.work.complete(auth.user, id, input, request);
  }
}

/**
 * Assignment, verification, reopening and closing for the organization handling a report.
 * Every action sends If-Match with the report version.
 */
@ApiTags('organization reports')
@Controller({ path: 'organizations/:organizationId', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class OrganizationWorkController {
  constructor(private readonly work: WorkService) {}

  @Get('workers')
  @RequireOrganizationPermission(OrganizationPermission.ManageAssignments)
  @ApiOperation({ summary: 'Active workers with availability and current workload.' })
  @ApiZodResponse(z.array(workerSchema))
  @ApiErrorResponses(404)
  workers(@Param('organizationId', uuid) organizationId: string) {
    return this.work.workers(organizationId);
  }

  @Post('reports/:publicId/assign')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ManageAssignments)
  @ApiOperation({ summary: 'ACCEPTED or REOPENED → ASSIGNED to an available worker.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(assignSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(assignSchema)) input: AssignInput,
    @Req() request: Request,
  ) {
    return this.work.assign(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input,
      auth.user.id,
      request,
    );
  }

  @Post('reports/:publicId/reassign')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ManageAssignments)
  @ApiOperation({ summary: 'Move the task to another worker, with a reason.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(reassignSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  reassign(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(reassignSchema)) input: ReassignInput,
    @Req() request: Request,
  ) {
    return this.work.reassign(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input,
      auth.user.id,
      request,
    );
  }

  @Post('reports/:publicId/cancel-assignment')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ManageAssignments)
  @ApiOperation({ summary: 'Cancel the open assignment (back to ACCEPTED), with a reason.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.work.cancelAssignment(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input.reason,
      auth.user.id,
      request,
    );
  }

  @Post('reports/:publicId/verify')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.VerifyWork)
  @ApiOperation({
    summary:
      'Verify completion evidence: APPROVED → RESOLVED; REJECTED or NEEDS_MORE_EVIDENCE → IN_PROGRESS. Never your own work.',
  })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(verifySchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 403, 404, 409, 422, 428)
  verify(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(verifySchema)) input: VerifyInput,
    @Req() request: Request,
  ) {
    return this.work.verify(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input,
      auth.user.id,
      request,
    );
  }

  @Post('reports/:publicId/reopen')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'RESOLVED → REOPENED, with a reason.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(400, 404, 409, 422, 428)
  reopen(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.work.reopen(
      organizationId,
      id,
      parseIfMatch(ifMatch),
      input.reason,
      auth.user.id,
      request,
    );
  }

  @Post('reports/:publicId/close')
  @HttpCode(200)
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({ summary: 'RESOLVED → CLOSED.' })
  @ApiHeader(ifMatchHeader)
  @ApiZodResponse(organizationReportSchema)
  @ApiErrorResponses(404, 409, 422, 428)
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('publicId', publicId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
  ) {
    return this.work.close(organizationId, id, parseIfMatch(ifMatch), auth.user.id, request);
  }
}

/** The reporting citizen's "Is it fixed?" answer. */
@ApiTags('reports')
@Controller({ path: 'reports', version: '1' })
export class ReportFeedbackController {
  constructor(private readonly work: WorkService) {}

  @Post(':publicId/feedback')
  @RequirePermissions(Permission.AccountSelf)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Tell the organization whether the resolved issue is fixed. Feedback never changes the status.',
  })
  @ApiZodBody(feedbackSchema)
  @ApiZodResponse(ownReportSchema)
  @ApiErrorResponses(400, 404, 409, 422)
  feedback(
    @CurrentAuth() auth: AuthContext,
    @Param('publicId', publicId) id: string,
    @Body(new ZodValidationPipe(feedbackSchema)) input: FeedbackInput,
    @Req() request: Request,
  ) {
    return this.work.giveFeedback(id, input, auth.user, request);
  }
}
