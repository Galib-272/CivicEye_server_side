import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { PlatformRole } from '../../generated/prisma/enums';
import {
  ORGANIZATION_ROLE_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  REQUIRES_VERIFIED_EMAIL,
  type OrganizationPermission,
  type Permission,
} from './permissions';

export interface PermissionSubject {
  platformRole: PlatformRole;
  emailVerifiedAt: Date | null;
}

export type PermissionDecision =
  { allowed: true } | { allowed: false; reason: 'missing_permission' | 'email_not_verified' };

/** Central authorization decisions. Deny by default: anything not granted is refused. */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  checkPlatformPermissions(
    subject: PermissionSubject,
    required: readonly Permission[],
  ): PermissionDecision {
    const granted = PLATFORM_ROLE_PERMISSIONS[subject.platformRole];
    if (!required.every((permission) => granted.has(permission))) {
      return { allowed: false, reason: 'missing_permission' };
    }
    if (
      subject.emailVerifiedAt === null &&
      required.some((permission) => REQUIRES_VERIFIED_EMAIL.has(permission))
    ) {
      return { allowed: false, reason: 'email_not_verified' };
    }
    return { allowed: true };
  }

  /**
   * True only if the user has an ACTIVE membership in an active organization whose role grants
   * the permission. Platform roles (including SUPER_ADMIN) do not imply organization access.
   */
  async hasOrganizationPermission(
    userId: string,
    organizationId: string,
    permission: OrganizationPermission,
  ): Promise<boolean> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, status: true, organization: { select: { isActive: true } } },
    });
    if (!membership || membership.status !== 'ACTIVE' || !membership.organization.isActive) {
      return false;
    }
    return ORGANIZATION_ROLE_PERMISSIONS[membership.role].has(permission);
  }
}
