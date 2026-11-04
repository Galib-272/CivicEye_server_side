import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
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
  Public,
  RequireOrganizationPermission,
  RequirePermissions,
} from '../auth/auth.decorators';
import { CategoriesService } from '../categories/categories.service';
import { ServiceAreasService } from '../service-areas/service-areas.service';
import { organizationMatchSchema, serviceAreaSchema } from '../service-areas/service-areas.schemas';
import { MembershipsService } from './memberships.service';
import {
  changeRoleSchema,
  invitationSchema,
  inviteSchema,
  memberSchema,
  myOrganizationSchema,
  organizationOverviewSchema,
  publicListQuerySchema,
  publicOrganizationSchema,
  setCategoriesSchema,
  tokenBodySchema,
  updateProfileSchema,
  type InviteInput,
  type UpdateProfileInput,
} from './organizations.schemas';
import { OrganizationsService } from './organizations.service';

const uuid = new ZodValidationPipe(z.uuid());

/**
 * Public directory plus each organization's own workspace. Workspace routes require an ACTIVE
 * membership in that organization; everyone else (including Super Admins) gets NOT_FOUND.
 */
@ApiTags('organizations')
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly memberships: MembershipsService,
    private readonly categories: CategoriesService,
    private readonly serviceAreas: ServiceAreasService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Public directory of verified organizations.' })
  @ApiZodQuery(publicListQuerySchema)
  @ApiZodPaginatedResponse(publicOrganizationSchema)
  list(
    @Query(new ZodValidationPipe(publicListQuerySchema))
    query: z.infer<typeof publicListQuerySchema>,
  ) {
    return this.organizations.publicList(query);
  }

  @Get(':organizationId')
  @Public()
  @ApiOperation({ summary: 'Public profile of a verified organization.' })
  @ApiZodResponse(publicOrganizationSchema)
  @ApiErrorResponses(404)
  profile(@Param('organizationId', uuid) organizationId: string) {
    return this.organizations.publicProfile(organizationId);
  }

  @Get(':organizationId/overview')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ViewOrganization)
  @ApiOperation({ summary: 'Workspace overview for members of this organization.' })
  @ApiZodResponse(organizationOverviewSchema)
  @ApiErrorResponses(404)
  overview(@CurrentAuth() auth: AuthContext, @Param('organizationId') organizationId: string) {
    return this.organizations.memberOverview(organizationId, auth.user.id);
  }

  @Patch(':organizationId')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageProfile)
  @ApiOperation({ summary: 'Edit the public profile (Org Admin).' })
  @ApiZodBody(updateProfileSchema)
  @ApiZodResponse(organizationOverviewSchema)
  @ApiErrorResponses(400, 404)
  async updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(updateProfileSchema)) input: UpdateProfileInput,
    @Req() request: Request,
  ) {
    await this.organizations.updateProfile(organizationId, input, auth.user.id, request);
    return this.organizations.memberOverview(organizationId, auth.user.id);
  }

  @Get(':organizationId/members')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ViewOrganization)
  @ApiOperation({ summary: 'Members of this organization.' })
  @ApiZodResponse(z.array(memberSchema))
  members(@Param('organizationId') organizationId: string) {
    return this.memberships.listMembers(organizationId);
  }

  @Get(':organizationId/invitations')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageMembers)
  @ApiOperation({ summary: 'Pending invitations (Org Admin).' })
  @ApiZodResponse(z.array(invitationSchema))
  invitations(@Param('organizationId') organizationId: string) {
    return this.memberships.listPendingInvitations(organizationId);
  }

  @Post(':organizationId/invitations')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageMembers)
  @ApiOperation({ summary: 'Invite someone to this organization (Org Admin).' })
  @ApiZodBody(inviteSchema)
  @ApiZodResponse(invitationSchema, 201)
  @ApiErrorResponses(400, 404, 409, 422)
  invite(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(inviteSchema)) input: InviteInput,
    @Req() request: Request,
  ) {
    return this.memberships.invite(organizationId, input, auth.user.id, request);
  }

  @Delete(':organizationId/invitations/:invitationId')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageMembers)
  @ApiOperation({ summary: 'Revoke a pending invitation (Org Admin).' })
  @ApiZodResponse(z.object({ accepted: z.literal(true) }))
  @ApiErrorResponses(404)
  async revokeInvitation(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Param('invitationId', uuid) invitationId: string,
    @Req() request: Request,
  ) {
    await this.memberships.revokeInvitation(organizationId, invitationId, auth.user.id, request);
    return { accepted: true as const };
  }

  @Patch(':organizationId/members/:memberId')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageMembers)
  @ApiOperation({ summary: 'Change a member’s role (Org Admin).' })
  @ApiZodBody(changeRoleSchema)
  @ApiZodResponse(z.array(memberSchema))
  @ApiErrorResponses(400, 404, 409)
  async changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Param('memberId', uuid) memberId: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) input: z.infer<typeof changeRoleSchema>,
    @Req() request: Request,
  ) {
    await this.memberships.changeRole(organizationId, memberId, input.role, auth.user.id, request);
    return this.memberships.listMembers(organizationId);
  }

  @Delete(':organizationId/members/:memberId')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageMembers)
  @ApiOperation({
    summary: 'Remove a member (Org Admin). The last administrator cannot be removed.',
  })
  @ApiZodResponse(z.array(memberSchema))
  @ApiErrorResponses(404, 409)
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Param('memberId', uuid) memberId: string,
    @Req() request: Request,
  ) {
    await this.memberships.removeMember(organizationId, memberId, auth.user.id, request);
    return this.memberships.listMembers(organizationId);
  }

  @Put(':organizationId/categories')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ManageCategories)
  @ApiOperation({ summary: 'Set the categories this organization handles (Org Admin).' })
  @ApiZodBody(setCategoriesSchema)
  @ApiZodResponse(organizationOverviewSchema)
  @ApiErrorResponses(400, 404)
  async setCategories(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(setCategoriesSchema)) input: z.infer<typeof setCategoriesSchema>,
    @Req() request: Request,
  ) {
    await this.categories.setOrganizationCategories(
      organizationId,
      input.categoryIds,
      auth.user.id,
      request,
    );
    return this.organizations.memberOverview(organizationId, auth.user.id);
  }

  @Get(':organizationId/service-areas')
  @RequirePermissions(Permission.AccountSelf)
  @RequireOrganizationPermission(OrganizationPermission.ViewOrganization)
  @ApiOperation({ summary: 'Service areas of this organization (read-only for members).' })
  @ApiZodResponse(z.array(serviceAreaSchema))
  serviceAreasList(@Param('organizationId') organizationId: string) {
    return this.serviceAreas.list(organizationId);
  }
}

@ApiTags('organizations')
@Controller({ version: '1' })
export class OrganizationEnrollmentController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly memberships: MembershipsService,
    private readonly serviceAreas: ServiceAreasService,
  ) {}

  @Get('users/me/organizations')
  @RequirePermissions(Permission.AccountSelf)
  @ApiOperation({ summary: 'Organizations the signed-in user is an active member of.' })
  @ApiZodResponse(z.array(myOrganizationSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    return this.organizations.myOrganizations(auth.user.id);
  }

  @Post('invitations/accept')
  @RequirePermissions(Permission.OrganizationJoin)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation. Requires a verified email matching the invited address.',
  })
  @ApiZodBody(tokenBodySchema)
  @ApiZodResponse(
    z.object({
      organizationId: z.uuid(),
      organizationName: z.string(),
      role: z.enum(['ORG_ADMIN', 'ORG_REVIEWER', 'WORKER']),
    }),
  )
  @ApiErrorResponses(400, 403, 409)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(tokenBodySchema)) input: { token: string },
    @Req() request: Request,
  ) {
    return this.memberships.accept(input.token, auth.user, request);
  }

  @Post('organization-contacts/confirm')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Verification contact confirms with the emailed link.' })
  @ApiZodBody(tokenBodySchema)
  @ApiZodResponse(z.object({ organizationName: z.string() }))
  @ApiErrorResponses(400)
  confirmContact(
    @Body(new ZodValidationPipe(tokenBodySchema)) input: { token: string },
    @Req() request: Request,
  ) {
    return this.organizations.confirmContact(input.token, request);
  }

  @Post('locations/organization-match')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Verified organizations whose service areas cover a WGS84 point (optionally for a category).',
  })
  @ApiZodBody(organizationMatchSchema)
  @ApiZodResponse(z.array(z.object({ id: z.uuid(), name: z.string() })))
  @ApiErrorResponses(400)
  match(
    @Body(new ZodValidationPipe(organizationMatchSchema))
    input: z.infer<typeof organizationMatchSchema>,
  ) {
    return this.serviceAreas.organizationsCovering(
      input.latitude,
      input.longitude,
      input.categoryId,
    );
  }
}
