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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { Permission } from '../access/permissions';
import { CategoriesService } from '../categories/categories.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/auth.decorators';
import { SERVICE_AREA_LIMITS, ServiceAreasService } from '../service-areas/service-areas.service';
import {
  overlapSchema,
  serviceAreaSchema,
  updateServiceAreaSchema,
} from '../service-areas/service-areas.schemas';
import { MembershipsService } from './memberships.service';
import {
  adminOrganizationListItemSchema,
  adminOrganizationSchema,
  adminUpdateOrganizationSchema,
  changeRoleSchema,
  createOrganizationSchema,
  invitationSchema,
  inviteSchema,
  listOrganizationsQuerySchema,
  memberSchema,
  optionalReasonSchema,
  reasonSchema,
  setCategoriesSchema,
  verificationContactSchema,
  type AdminUpdateOrganizationInput,
  type CreateOrganizationInput,
  type InviteInput,
  type ListOrganizationsQuery,
  type VerificationContactInput,
} from './organizations.schemas';
import { OrganizationsService } from './organizations.service';

interface UploadedGeoJson {
  buffer: Buffer;
  size: number;
}

const uuid = new ZodValidationPipe(z.uuid());
const serviceAreaNameSchema = z.string().trim().min(2).max(200);

/** Super Admin management of every organization (approved: Super Admins create organizations). */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
@RequirePermissions(Permission.AdminOrganizationsManage)
export class AdminOrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly memberships: MembershipsService,
    private readonly serviceAreas: ServiceAreasService,
    private readonly categories: CategoriesService,
  ) {}

  @Get('organizations')
  @ApiOperation({ summary: 'List organizations (Super Admin).' })
  @ApiZodQuery(listOrganizationsQuerySchema)
  @ApiZodPaginatedResponse(adminOrganizationListItemSchema)
  list(@Query(new ZodValidationPipe(listOrganizationsQuerySchema)) query: ListOrganizationsQuery) {
    return this.organizations.adminList(query);
  }

  @Post('organizations')
  @ApiOperation({ summary: 'Create an organization (Super Admin).' })
  @ApiZodBody(createOrganizationSchema)
  @ApiZodResponse(adminOrganizationSchema, 201)
  @ApiErrorResponses(400, 409)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createOrganizationSchema)) input: CreateOrganizationInput,
    @Req() request: Request,
  ) {
    return this.organizations.create(input, auth.user.id, request);
  }

  @Get('organizations/:organizationId')
  @ApiOperation({ summary: 'Organization details including verification (Super Admin).' })
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(404)
  detail(@Param('organizationId', uuid) organizationId: string) {
    return this.organizations.adminDetail(organizationId);
  }

  @Patch('organizations/:organizationId')
  @ApiOperation({ summary: 'Edit any organization field (Super Admin).' })
  @ApiZodBody(adminUpdateOrganizationSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(400, 404, 409)
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(adminUpdateOrganizationSchema)) input: AdminUpdateOrganizationInput,
    @Req() request: Request,
  ) {
    await this.organizations.updateProfile(organizationId, input, auth.user.id, request);
    return this.organizations.adminDetail(organizationId);
  }

  @Put('organizations/:organizationId/verification-contact')
  @ApiOperation({
    summary:
      'Name the verification contact (on the official domain) and email them a confirmation link.',
  })
  @ApiZodBody(verificationContactSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(400, 404, 422)
  setContact(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(verificationContactSchema)) input: VerificationContactInput,
    @Req() request: Request,
  ) {
    return this.organizations.setVerificationContact(organizationId, input, auth.user.id, request);
  }

  @Post('organizations/:organizationId/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve verification once the contact has confirmed.' })
  @ApiZodBody(optionalReasonSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(404, 422)
  verify(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(optionalReasonSchema)) input: { reason?: string },
    @Req() request: Request,
  ) {
    return this.organizations.transition(
      organizationId,
      { action: 'verify', to: 'VERIFIED' },
      input.reason ?? null,
      auth.user.id,
      request,
    );
  }

  @Post('organizations/:organizationId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject verification (reason required).' })
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(400, 404, 422)
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.organizations.transition(
      organizationId,
      { action: 'reject', to: 'REJECTED' },
      input.reason,
      auth.user.id,
      request,
    );
  }

  @Post('organizations/:organizationId/suspend')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suspend a verified organization; members lose access (reason required).',
  })
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(400, 404, 422)
  suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.organizations.transition(
      organizationId,
      { action: 'suspend', to: 'SUSPENDED' },
      input.reason,
      auth.user.id,
      request,
    );
  }

  @Post('organizations/:organizationId/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reactivate a suspended organization (reason required).' })
  @ApiZodBody(reasonSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(400, 404, 422)
  reactivate(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(reasonSchema)) input: { reason: string },
    @Req() request: Request,
  ) {
    return this.organizations.transition(
      organizationId,
      { action: 'reactivate', to: 'VERIFIED' },
      input.reason,
      auth.user.id,
      request,
    );
  }

  @Put('organizations/:organizationId/categories')
  @ApiOperation({ summary: 'Set the categories an organization handles (Super Admin).' })
  @ApiZodBody(setCategoriesSchema)
  @ApiZodResponse(adminOrganizationSchema)
  @ApiErrorResponses(400, 404)
  async setCategories(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(setCategoriesSchema)) input: z.infer<typeof setCategoriesSchema>,
    @Req() request: Request,
  ) {
    await this.organizations.findRow(organizationId);
    await this.categories.setOrganizationCategories(
      organizationId,
      input.categoryIds,
      auth.user.id,
      request,
    );
    return this.organizations.adminDetail(organizationId);
  }

  // ─── Members of any organization ─────────────────────────────────────────────

  @Get('organizations/:organizationId/members')
  @ApiOperation({ summary: 'Members of an organization (Super Admin).' })
  @ApiZodResponse(z.array(memberSchema))
  members(@Param('organizationId', uuid) organizationId: string) {
    return this.memberships.listMembers(organizationId);
  }

  @Get('organizations/:organizationId/invitations')
  @ApiOperation({ summary: 'Pending invitations of an organization (Super Admin).' })
  @ApiZodResponse(z.array(invitationSchema))
  invitations(@Param('organizationId', uuid) organizationId: string) {
    return this.memberships.listPendingInvitations(organizationId);
  }

  @Post('organizations/:organizationId/invitations')
  @ApiOperation({ summary: 'Invite someone, e.g. the first Org Admin (Super Admin).' })
  @ApiZodBody(inviteSchema)
  @ApiZodResponse(invitationSchema, 201)
  @ApiErrorResponses(400, 404, 409, 422)
  invite(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(inviteSchema)) input: InviteInput,
    @Req() request: Request,
  ) {
    return this.memberships.invite(organizationId, input, auth.user.id, request);
  }

  @Delete('organizations/:organizationId/invitations/:invitationId')
  @ApiOperation({ summary: 'Revoke a pending invitation (Super Admin).' })
  @ApiZodResponse(z.object({ accepted: z.literal(true) }))
  @ApiErrorResponses(404)
  async revokeInvitation(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('invitationId', uuid) invitationId: string,
    @Req() request: Request,
  ) {
    await this.memberships.revokeInvitation(organizationId, invitationId, auth.user.id, request);
    return { accepted: true as const };
  }

  @Patch('organizations/:organizationId/members/:memberId')
  @ApiOperation({ summary: 'Change a member’s role (Super Admin).' })
  @ApiZodBody(changeRoleSchema)
  @ApiZodResponse(z.array(memberSchema))
  @ApiErrorResponses(400, 404, 409)
  async changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('memberId', uuid) memberId: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) input: z.infer<typeof changeRoleSchema>,
    @Req() request: Request,
  ) {
    await this.memberships.changeRole(organizationId, memberId, input.role, auth.user.id, request);
    return this.memberships.listMembers(organizationId);
  }

  @Delete('organizations/:organizationId/members/:memberId')
  @ApiOperation({ summary: 'Remove a member (Super Admin).' })
  @ApiZodResponse(z.array(memberSchema))
  @ApiErrorResponses(404, 409)
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Param('memberId', uuid) memberId: string,
    @Req() request: Request,
  ) {
    await this.memberships.removeMember(organizationId, memberId, auth.user.id, request);
    return this.memberships.listMembers(organizationId);
  }

  // ─── Service areas ───────────────────────────────────────────────────────────

  @Get('organizations/:organizationId/service-areas')
  @ApiOperation({ summary: 'Service areas of an organization (Super Admin).' })
  @ApiZodResponse(z.array(serviceAreaSchema))
  listServiceAreas(@Param('organizationId', uuid) organizationId: string) {
    return this.serviceAreas.list(organizationId);
  }

  @Post('organizations/:organizationId/service-areas')
  @ApiOperation({
    summary: 'Upload a service area as a GeoJSON file (Polygon/MultiPolygon, WGS84, at most 5 MB).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'file'],
      properties: { name: { type: 'string' }, file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiZodResponse(serviceAreaSchema, 201)
  @ApiErrorResponses(400, 404, 413)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: SERVICE_AREA_LIMITS.maxFileBytes, files: 1, fields: 2 },
    }),
  )
  createServiceArea(
    @CurrentAuth() auth: AuthContext,
    @Param('organizationId', uuid) organizationId: string,
    @Body('name', new ZodValidationPipe(serviceAreaNameSchema)) name: string,
    @UploadedFile() file: UploadedGeoJson | undefined,
    @Req() request: Request,
  ) {
    if (!file) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'Attach a GeoJSON file.', [
        { field: 'file', message: 'Attach a GeoJSON file.' },
      ]);
    }
    return this.serviceAreas.create(
      organizationId,
      name,
      file.buffer.toString('utf8'),
      auth.user.id,
      request,
    );
  }

  @Patch('service-areas/:serviceAreaId')
  @ApiOperation({ summary: 'Rename or (de)activate a service area (Super Admin).' })
  @ApiZodBody(updateServiceAreaSchema)
  @ApiZodResponse(serviceAreaSchema)
  @ApiErrorResponses(400, 404)
  updateServiceArea(
    @CurrentAuth() auth: AuthContext,
    @Param('serviceAreaId', uuid) serviceAreaId: string,
    @Body(new ZodValidationPipe(updateServiceAreaSchema))
    input: z.infer<typeof updateServiceAreaSchema>,
    @Req() request: Request,
  ) {
    return this.serviceAreas.update(serviceAreaId, input, auth.user.id, request);
  }

  @Get('service-areas/overlaps')
  @ApiOperation({ summary: 'Overlapping active service areas of different organizations.' })
  @ApiZodResponse(z.array(overlapSchema))
  overlaps() {
    return this.serviceAreas.overlaps();
  }
}
