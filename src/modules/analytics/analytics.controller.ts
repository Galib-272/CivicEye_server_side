import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodQuery, ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { OrganizationPermission, Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import {
  CurrentAuth,
  RequireOrganizationPermission,
  RequirePermissions,
} from '../auth/auth.decorators';
import {
  citizenAnalyticsSchema,
  organizationAnalyticsSchema,
  platformAnalyticsSchema,
  rangeQuerySchema,
  workerAnalyticsSchema,
  type RangeQuery,
} from './analytics.schemas';
import { AnalyticsService } from './analytics.service';

const range = new ZodValidationPipe(rangeQuerySchema);

/** The signed-in person's own dashboards: their reports, and their tasks as a worker. */
@ApiTags('dashboards')
@Controller({ path: 'users/me', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class MyDashboardsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Your reports: totals, open and resolved, recent activity (docs/metrics.md).',
  })
  @ApiZodResponse(citizenAnalyticsSchema)
  citizen(@CurrentAuth() auth: AuthContext) {
    return this.analytics.citizen(auth.user.id);
  }

  @Get('work-dashboard')
  @ApiOperation({ summary: 'Your tasks as a worker, across your organizations (docs/metrics.md).' })
  @ApiZodResponse(workerAnalyticsSchema)
  worker(@CurrentAuth() auth: AuthContext) {
    return this.analytics.worker(auth.user.id);
  }
}

/** An organization's dashboard, for its Org Admins and Reviewers. */
@ApiTags('dashboards')
@Controller({ path: 'organizations/:organizationId/analytics', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class OrganizationAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @RequireOrganizationPermission(OrganizationPermission.ReviewReports)
  @ApiOperation({
    summary: 'Backlog now; volume, times, workload, categories, areas in a date range.',
  })
  @ApiZodQuery(rangeQuerySchema)
  @ApiZodResponse(organizationAnalyticsSchema)
  @ApiErrorResponses(400, 404)
  organization(
    @Param('organizationId', new ZodValidationPipe(z.uuid())) organizationId: string,
    @Query(range) query: RangeQuery,
  ) {
    return this.analytics.organization(organizationId, query);
  }
}

/** The platform dashboard (Super Admins). */
@ApiTags('admin')
@Controller({ path: 'admin/analytics', version: '1' })
@RequirePermissions(Permission.AdminAnalyticsView)
export class PlatformAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiOperation({ summary: 'Users, organizations, reports, performance, activity and moderation.' })
  @ApiZodQuery(rangeQuerySchema)
  @ApiZodResponse(platformAnalyticsSchema)
  @ApiErrorResponses(400)
  platform(@Query(range) query: RangeQuery) {
    return this.analytics.platform(query);
  }
}
