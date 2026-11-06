import type { OrganizationRole, PlatformRole } from '../../generated/prisma/enums';

/**
 * Platform permissions. Every protected endpoint declares the permissions it needs with
 * @RequirePermissions(); the AuthGuard checks them on the server for every request.
 */
export const Permission = {
  /** Read and manage one's own account, sessions and two-factor settings. */
  AccountSelf: 'account.self',
  /** Submit civic reports (Phase 4). */
  ReportCreate: 'report.create',
  /** Comment on reports (Phase 5). */
  CommentCreate: 'comment.create',
  /** Accept an organization invitation (Phase 3). */
  OrganizationJoin: 'organization.join',
  AdminUsersRead: 'admin.users.read',
  AdminUsersManage: 'admin.users.manage',
  /** Create, verify and suspend organizations; manage members and service areas of any organization. */
  AdminOrganizationsManage: 'admin.organizations.manage',
  AdminCategoriesManage: 'admin.categories.manage',
  /** See reports no organization covers and route them manually. */
  AdminReportsTriage: 'admin.reports.triage',
  AdminReportsManage: 'admin.reports.manage',
  AdminDeliveryManage: 'admin.delivery.manage',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/** Approved policy: these actions require a verified email address. */
export const REQUIRES_VERIFIED_EMAIL: ReadonlySet<Permission> = new Set([
  Permission.ReportCreate,
  Permission.CommentCreate,
  Permission.OrganizationJoin,
]);

const CITIZEN_PERMISSIONS: Permission[] = [
  Permission.AccountSelf,
  Permission.ReportCreate,
  Permission.CommentCreate,
  Permission.OrganizationJoin,
];

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, ReadonlySet<Permission>> = {
  CITIZEN: new Set(CITIZEN_PERMISSIONS),
  SUPER_ADMIN: new Set([
    ...CITIZEN_PERMISSIONS,
    Permission.AdminUsersRead,
    Permission.AdminUsersManage,
    Permission.AdminOrganizationsManage,
    Permission.AdminCategoriesManage,
    Permission.AdminReportsTriage,
    Permission.AdminReportsManage,
    Permission.AdminDeliveryManage,
  ]),
};

/**
 * Organization-scoped permissions. A user's platform role never grants these; only an ACTIVE
 * membership in that specific organization does (PRD §7.3).
 */
export const OrganizationPermission = {
  ViewOrganization: 'org.view',
  ManageProfile: 'org.profile.manage',
  ManageMembers: 'org.members.manage',
  ManageCategories: 'org.categories.manage',
  ReviewReports: 'org.reports.review',
  VerifyWork: 'org.work.verify',
  ManageAssignments: 'org.assignments.manage',
  WorkAssignedTasks: 'org.tasks.work',
} as const;

export type OrganizationPermission =
  (typeof OrganizationPermission)[keyof typeof OrganizationPermission];

export const ORGANIZATION_ROLE_PERMISSIONS: Record<
  OrganizationRole,
  ReadonlySet<OrganizationPermission>
> = {
  ORG_ADMIN: new Set([
    OrganizationPermission.ViewOrganization,
    OrganizationPermission.ManageProfile,
    OrganizationPermission.ManageMembers,
    OrganizationPermission.ManageCategories,
    OrganizationPermission.ReviewReports,
    OrganizationPermission.VerifyWork,
    OrganizationPermission.ManageAssignments,
  ]),
  ORG_REVIEWER: new Set([
    OrganizationPermission.ViewOrganization,
    OrganizationPermission.ReviewReports,
    OrganizationPermission.VerifyWork,
    OrganizationPermission.ManageAssignments,
  ]),
  WORKER: new Set([
    OrganizationPermission.ViewOrganization,
    OrganizationPermission.WorkAssignedTasks,
  ]),
};
