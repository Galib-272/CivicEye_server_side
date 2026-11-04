import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/http/api-response';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { OrganizationVerificationState } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import { generateToken, sha256Hex } from '../auth/crypto';
import { EmailService } from '../email/email.service';
import type {
  AdminUpdateOrganizationInput,
  adminOrganizationSchema,
  CreateOrganizationInput,
  ListOrganizationsQuery,
  organizationOverviewSchema,
  publicOrganizationSchema,
  UpdateProfileInput,
  VerificationContactInput,
} from './organizations.schemas';

const CONTACT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ORGANIZATION_SELECT = {
  id: true,
  name: true,
  type: true,
  description: true,
  website: true,
  publicEmail: true,
  publicPhone: true,
  officialEmailDomain: true,
  verificationState: true,
  isActive: true,
  createdAt: true,
  categories: { select: { categoryId: true } },
  _count: { select: { members: { where: { status: 'ACTIVE' } } } },
} as const;

type OrganizationRow = Prisma.OrganizationGetPayload<{ select: typeof ORGANIZATION_SELECT }>;

type Transition =
  | { action: 'verify'; to: 'VERIFIED' }
  | { action: 'reject'; to: 'REJECTED' }
  | { action: 'suspend'; to: 'SUSPENDED' }
  | { action: 'reactivate'; to: 'VERIFIED' };

/** Allowed verification state changes. Anything else is INVALID_STATE_TRANSITION. */
const ALLOWED_FROM: Record<Transition['action'], OrganizationVerificationState[]> = {
  verify: ['PENDING_VERIFICATION'],
  reject: ['PENDING_VERIFICATION'],
  suspend: ['VERIFIED'],
  reactivate: ['SUSPENDED'],
};

const TRANSITION_AUDIT_ACTION: Record<Transition['action'], string> = {
  verify: 'organization.verified',
  reject: 'organization.rejected',
  suspend: 'organization.suspended',
  reactivate: 'organization.reactivated',
};

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** True if the email's domain is the official domain or one of its subdomains. */
export function isOnOfficialDomain(email: string, officialDomain: string): boolean {
  const domain = emailDomain(email);
  return domain === officialDomain || domain.endsWith(`.${officialDomain}`);
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // ─── Views ──────────────────────────────────────────────────────────────────

  toPublic(row: OrganizationRow): z.infer<typeof publicOrganizationSchema> {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      website: row.website,
      publicEmail: row.publicEmail,
      publicPhone: row.publicPhone,
    };
  }

  toOverview(
    row: OrganizationRow,
    myRole: z.infer<typeof organizationOverviewSchema>['myRole'],
  ): z.infer<typeof organizationOverviewSchema> {
    return {
      ...this.toPublic(row),
      officialEmailDomain: row.officialEmailDomain,
      verificationState: row.verificationState,
      isActive: row.isActive,
      memberCount: row._count.members,
      categoryIds: row.categories.map((category) => category.categoryId),
      myRole,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async findRow(organizationId: string): Promise<OrganizationRow> {
    const row = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: ORGANIZATION_SELECT,
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row;
  }

  /** Overview for a member (access already checked by the guard). */
  async memberOverview(organizationId: string, userId: string) {
    const [row, membership] = await Promise.all([
      this.findRow(organizationId),
      this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true },
      }),
    ]);
    return this.toOverview(row, membership?.role ?? null);
  }

  async adminDetail(organizationId: string): Promise<z.infer<typeof adminOrganizationSchema>> {
    const row = await this.findRow(organizationId);
    const [contact, history] = await Promise.all([
      this.prisma.organizationVerificationContact.findUnique({ where: { organizationId } }),
      this.prisma.organizationVerificationRecord.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: {
          fromState: true,
          toState: true,
          reason: true,
          createdAt: true,
          decidedBy: { select: { name: true } },
        },
      }),
    ]);
    return {
      ...this.toOverview(row, null),
      verificationContact: contact
        ? {
            name: contact.name,
            jobTitle: contact.jobTitle,
            email: contact.email,
            confirmedAt: contact.confirmedAt?.toISOString() ?? null,
            linkExpiresAt: contact.confirmedAt
              ? null
              : (contact.tokenExpiresAt?.toISOString() ?? null),
          }
        : null,
      verificationHistory: history.map((record) => ({
        fromState: record.fromState,
        toState: record.toState,
        reason: record.reason,
        decidedBy: record.decidedBy.name,
        createdAt: record.createdAt.toISOString(),
      })),
    };
  }

  async adminList(query: ListOrganizationsQuery) {
    const where: Prisma.OrganizationWhereInput = {
      verificationState: query.verificationState,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        select: ORGANIZATION_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    const items = rows.map((row) => {
      const { myRole: _role, categoryIds: _categories, ...item } = this.toOverview(row, null);
      return item;
    });
    return new Paginated(items, { page: query.page, limit: query.limit, total });
  }

  /** Public directory: verified, active organizations only. */
  async publicList(query: Omit<ListOrganizationsQuery, 'verificationState'>) {
    const where: Prisma.OrganizationWhereInput = {
      verificationState: 'VERIFIED',
      isActive: true,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        select: ORGANIZATION_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return new Paginated(
      rows.map((row) => this.toPublic(row)),
      { page: query.page, limit: query.limit, total },
    );
  }

  async publicProfile(organizationId: string) {
    const row = await this.prisma.organization.findFirst({
      where: { id: organizationId, verificationState: 'VERIFIED', isActive: true },
      select: ORGANIZATION_SELECT,
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return this.toPublic(row);
  }

  async myOrganizations(userId: string) {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { organization: { name: 'asc' } },
      select: {
        role: true,
        organization: { select: { id: true, name: true, verificationState: true, isActive: true } },
      },
    });
    return memberships.map(({ role, organization }) => ({ ...organization, role }));
  }

  // ─── Changes ────────────────────────────────────────────────────────────────

  async create(input: CreateOrganizationInput, actorId: string, request: Request) {
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const created = await tx.organization.create({
          data: { ...input, createdById: actorId },
          select: { id: true },
        });
        await this.audit.record(
          {
            action: 'organization.created',
            result: 'SUCCESS',
            actorUserId: actorId,
            targetType: 'organization',
            targetId: created.id,
            metadata: { name: input.name, officialEmailDomain: input.officialEmailDomain },
          },
          request,
          tx,
        );
        return created.id;
      });
      return this.adminDetail(id);
    } catch (error) {
      throw this.duplicateName(error);
    }
  }

  async updateProfile(
    organizationId: string,
    input: UpdateProfileInput | AdminUpdateOrganizationInput,
    actorId: string,
    request: Request,
  ) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { officialEmailDomain: true, verificationState: true },
        });
        if (!before) throw new AppException(ErrorCode.NOT_FOUND);
        if (
          'officialEmailDomain' in input &&
          input.officialEmailDomain &&
          input.officialEmailDomain !== before.officialEmailDomain &&
          before.verificationState !== 'UNVERIFIED' &&
          before.verificationState !== 'REJECTED'
        ) {
          // Changing the domain would invalidate a completed or in-progress verification.
          throw new AppException(
            ErrorCode.CONFLICT,
            'The official domain can only be changed before verification starts or after rejection.',
          );
        }
        await tx.organization.update({ where: { id: organizationId }, data: input });
        await this.audit.record(
          {
            action: 'organization.updated',
            result: 'SUCCESS',
            actorUserId: actorId,
            targetType: 'organization',
            targetId: organizationId,
            metadata: { fields: Object.keys(input) },
          },
          request,
          tx,
        );
      });
    } catch (error) {
      throw this.duplicateName(error);
    }
  }

  /**
   * Names (or replaces) the verification contact and emails them a confirmation link. The
   * organization moves to PENDING_VERIFICATION. The contact's email must be on the official domain.
   */
  async setVerificationContact(
    organizationId: string,
    input: VerificationContactInput,
    actorId: string,
    request: Request,
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, officialEmailDomain: true, verificationState: true },
    });
    if (!organization) throw new AppException(ErrorCode.NOT_FOUND);
    if (
      !['UNVERIFIED', 'PENDING_VERIFICATION', 'REJECTED'].includes(organization.verificationState)
    ) {
      throw new AppException(ErrorCode.INVALID_STATE_TRANSITION);
    }
    if (!isOnOfficialDomain(input.email, organization.officialEmailDomain)) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        {
          field: 'email',
          message: `The contact must use an @${organization.officialEmailDomain} address.`,
        },
      ]);
    }

    const token = generateToken();
    const tokenFields = {
      ...input,
      tokenHash: sha256Hex(token),
      tokenExpiresAt: new Date(Date.now() + CONTACT_LINK_TTL_MS),
      confirmedAt: null,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationVerificationContact.upsert({
        where: { organizationId },
        create: { organizationId, ...tokenFields },
        update: tokenFields,
      });
      if (organization.verificationState !== 'PENDING_VERIFICATION') {
        await tx.organization.update({
          where: { id: organizationId },
          data: { verificationState: 'PENDING_VERIFICATION' },
        });
        await this.recordTransition(
          tx,
          organizationId,
          organization.verificationState,
          'PENDING_VERIFICATION',
          actorId,
          null,
        );
      }
      await this.audit.record(
        {
          action: 'organization.contact_set',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: { contactDomain: emailDomain(input.email) },
        },
        request,
        tx,
      );
    });

    this.email.sendInBackground(
      { email: input.email, name: input.name, preferredLocale: 'en' },
      {
        name: 'organization-contact-confirmation',
        organizationName: organization.name,
        link: this.email.webLink('en', '/organization-contact/confirm', { token }),
      },
    );
    return this.adminDetail(organizationId);
  }

  /** The contact follows the emailed link. Single-use and time-limited. */
  async confirmContact(token: string, request: Request): Promise<{ organizationName: string }> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const contact = await tx.organizationVerificationContact.findUnique({
        where: { tokenHash: sha256Hex(token) },
        select: {
          id: true,
          organizationId: true,
          tokenExpiresAt: true,
          confirmedAt: true,
          organization: { select: { name: true, verificationState: true } },
        },
      });
      if (
        !contact ||
        contact.confirmedAt ||
        !contact.tokenExpiresAt ||
        contact.tokenExpiresAt <= now ||
        contact.organization.verificationState !== 'PENDING_VERIFICATION'
      ) {
        throw new AppException(ErrorCode.INVALID_TOKEN);
      }
      const claimed = await tx.organizationVerificationContact.updateMany({
        where: { id: contact.id, confirmedAt: null },
        data: { confirmedAt: now, tokenHash: null },
      });
      if (claimed.count !== 1) throw new AppException(ErrorCode.INVALID_TOKEN);
      await this.audit.record(
        {
          action: 'organization.contact_confirmed',
          result: 'SUCCESS',
          targetType: 'organization',
          targetId: contact.organizationId,
        },
        request,
        tx,
      );
      return { organizationName: contact.organization.name };
    });
  }

  async transition(
    organizationId: string,
    transition: Transition,
    reason: string | null,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Lock the row so two administrators cannot make conflicting decisions at once.
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { verificationState: true, verificationContact: { select: { confirmedAt: true } } },
      });
      if (!organization) throw new AppException(ErrorCode.NOT_FOUND);
      if (!ALLOWED_FROM[transition.action].includes(organization.verificationState)) {
        throw new AppException(ErrorCode.INVALID_STATE_TRANSITION);
      }
      if (transition.action === 'verify' && !organization.verificationContact?.confirmedAt) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'The verification contact has not confirmed yet.',
        );
      }
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          verificationState: transition.to,
          // Suspended organizations lose all member access until reactivated.
          isActive: transition.action !== 'suspend',
        },
      });
      await this.recordTransition(
        tx,
        organizationId,
        organization.verificationState,
        transition.to,
        actorId,
        reason,
      );
      await this.audit.record(
        {
          action: TRANSITION_AUDIT_ACTION[transition.action],
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          reason: reason ?? undefined,
          metadata: { from: organization.verificationState, to: transition.to },
        },
        request,
        tx,
      );
    });
    return this.adminDetail(organizationId);
  }

  private recordTransition(
    tx: Prisma.TransactionClient,
    organizationId: string,
    fromState: OrganizationVerificationState,
    toState: OrganizationVerificationState,
    decidedById: string,
    reason: string | null,
  ) {
    return tx.organizationVerificationRecord.create({
      data: { organizationId, fromState, toState, decidedById, reason },
    });
  }

  private duplicateName(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new AppException(
        ErrorCode.CONFLICT,
        'An organization with this name already exists.',
        [{ field: 'name', message: 'An organization with this name already exists.' }],
      );
    }
    return error;
  }
}
