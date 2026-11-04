import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OrganizationPermission, Permission } from '../access/permissions';

export const IS_PUBLIC = 'civiceye:auth:public';
export const REQUIRED_PERMISSIONS = 'civiceye:auth:permissions';
export const ALLOW_INCOMPLETE_MFA = 'civiceye:auth:allow-incomplete-mfa';
export const ORGANIZATION_PERMISSION = 'civiceye:auth:organization-permission';

/** No sign-in required. Every route must be @Public() or declare @RequirePermissions(). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Requires a signed-in user whose role grants all the listed permissions. */
export const RequirePermissions = (...permissions: [Permission, ...Permission[]]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Requires an ACTIVE membership in the organization named by the `:organizationId` route
 * parameter, with a role that grants the permission. Use together with @RequirePermissions().
 * Non-members get NOT_FOUND, so other organizations' existence is not revealed.
 */
export const RequireOrganizationPermission = (permission: OrganizationPermission) =>
  SetMetadata(ORGANIZATION_PERMISSION, permission);

/** Allows the route while two-factor verification or setup is still outstanding. */
export const AllowIncompleteMfa = () => SetMetadata(ALLOW_INCOMPLETE_MFA, true);

/** The authenticated user and session for this request (set by AuthGuard). */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const auth = context.switchToHttp().getRequest<Request>().auth;
  if (!auth) {
    throw new Error('CurrentAuth used on a route without authentication');
  }
  return auth;
});
