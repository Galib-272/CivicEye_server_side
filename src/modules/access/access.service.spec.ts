import type { PrismaService } from '../../database/prisma.service';
import { AccessService } from './access.service';
import { OrganizationPermission, Permission } from './permissions';

function serviceWithMembership(membership: unknown) {
  const prisma = {
    organizationMember: { findUnique: jest.fn().mockResolvedValue(membership) },
  } as unknown as PrismaService;
  return new AccessService(prisma);
}

const verified = new Date();

describe('AccessService.checkPlatformPermissions', () => {
  const access = serviceWithMembership(null);

  it('grants citizens their own account permissions', () => {
    expect(
      access.checkPlatformPermissions({ platformRole: 'CITIZEN', emailVerifiedAt: null }, [
        Permission.AccountSelf,
      ]),
    ).toEqual({ allowed: true });
  });

  it('denies administrative permissions to citizens', () => {
    expect(
      access.checkPlatformPermissions({ platformRole: 'CITIZEN', emailVerifiedAt: verified }, [
        Permission.AdminUsersRead,
      ]),
    ).toEqual({ allowed: false, reason: 'missing_permission' });
  });

  it('requires every listed permission, not just one', () => {
    expect(
      access.checkPlatformPermissions({ platformRole: 'CITIZEN', emailVerifiedAt: verified }, [
        Permission.AccountSelf,
        Permission.AdminUsersManage,
      ]).allowed,
    ).toBe(false);
  });

  it.each([Permission.ReportCreate, Permission.CommentCreate, Permission.OrganizationJoin])(
    'requires a verified email for %s',
    (permission) => {
      expect(
        access.checkPlatformPermissions({ platformRole: 'CITIZEN', emailVerifiedAt: null }, [
          permission,
        ]),
      ).toEqual({ allowed: false, reason: 'email_not_verified' });
      expect(
        access.checkPlatformPermissions({ platformRole: 'CITIZEN', emailVerifiedAt: verified }, [
          permission,
        ]),
      ).toEqual({ allowed: true });
    },
  );

  it('grants Super Admins user management', () => {
    expect(
      access.checkPlatformPermissions({ platformRole: 'SUPER_ADMIN', emailVerifiedAt: verified }, [
        Permission.AdminUsersRead,
        Permission.AdminUsersManage,
      ]),
    ).toEqual({ allowed: true });
  });
});

describe('AccessService.hasOrganizationPermission', () => {
  const activeOrg = { organization: { isActive: true } };

  it('grants permissions of an ACTIVE membership role', async () => {
    const access = serviceWithMembership({ role: 'ORG_ADMIN', status: 'ACTIVE', ...activeOrg });
    await expect(
      access.hasOrganizationPermission('u', 'o', OrganizationPermission.ReviewReports),
    ).resolves.toBe(true);
  });

  it('does not let workers review reports or manage members', async () => {
    const access = serviceWithMembership({ role: 'WORKER', status: 'ACTIVE', ...activeOrg });
    await expect(
      access.hasOrganizationPermission('u', 'o', OrganizationPermission.ReviewReports),
    ).resolves.toBe(false);
    await expect(
      access.hasOrganizationPermission('u', 'o', OrganizationPermission.ManageMembers),
    ).resolves.toBe(false);
    await expect(
      access.hasOrganizationPermission('u', 'o', OrganizationPermission.WorkAssignedTasks),
    ).resolves.toBe(true);
  });

  it.each([
    ['no membership', null],
    ['an invitation not yet accepted', { role: 'ORG_ADMIN', status: 'INVITED', ...activeOrg }],
    ['a removed membership', { role: 'ORG_ADMIN', status: 'REMOVED', ...activeOrg }],
    [
      'an inactive organization',
      { role: 'ORG_ADMIN', status: 'ACTIVE', organization: { isActive: false } },
    ],
  ])('denies access with %s', async (_label, membership) => {
    const access = serviceWithMembership(membership);
    await expect(
      access.hasOrganizationPermission('u', 'o', OrganizationPermission.ViewOrganization),
    ).resolves.toBe(false);
  });
});
