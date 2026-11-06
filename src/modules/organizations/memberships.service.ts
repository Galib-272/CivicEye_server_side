import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { OrganizationRole, PreferredLocale } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth-context';
import { generateToken, sha256Hex } from '../auth/crypto';
import { EmailService } from '../email/email.service';
import type { InviteInput } from './organizations.schemas';
import { releaseOpenAssignments } from '../reports/assignment-workflow';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_LABELS: Record<PreferredLocale, Record<OrganizationRole, string>> = {
  en: { ORG_ADMIN: 'an administrator', ORG_REVIEWER: 'a reviewer', WORKER: 'a worker' },
  bn: { ORG_ADMIN: 'প্রশাসক', ORG_REVIEWER: 'পর্যালোচক', WORKER: 'কর্মী' },
};

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async listMembers(organizationId: string) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, status: 'ACTIVE' },
      orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }],
      select: {
        id: true,
        userId: true,
        role: true,
        approvedAt: true,
        user: { select: { name: true, email: true } },
      },
    });
    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      joinedAt: member.approvedAt?.toISOString() ?? null,
    }));
  }

  async listPendingInvitations(organizationId: string) {
    const invitations = await this.prisma.organizationInvitation.findMany({
      where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    return invitations.map((invitation) => ({
      ...invitation,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    }));
  }

  /** Invites an email address. Re-inviting the same address replaces the earlier invitation. */
  async invite(organizationId: string, input: InviteInput, actorId: string, request: Request) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, isActive: true },
    });
    if (!organization) throw new AppException(ErrorCode.NOT_FOUND);
    if (!organization.isActive) {
      throw new AppException(
        ErrorCode.ORGANIZATION_NOT_ELIGIBLE,
        'This organization is suspended.',
      );
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, preferredLocale: true },
    });
    if (existingUser) {
      const membership = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: existingUser.id } },
        select: { status: true },
      });
      if (membership?.status === 'ACTIVE') {
        throw new AppException(ErrorCode.CONFLICT, 'This person is already a member.');
      }
    }

    const token = generateToken();
    const invitation = await this.prisma.$transaction(async (tx) => {
      await tx.organizationInvitation.updateMany({
        where: { organizationId, email: input.email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const created = await tx.organizationInvitation.create({
        data: {
          organizationId,
          email: input.email,
          role: input.role,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          invitedById: actorId,
        },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });
      await this.audit.record(
        {
          action: 'organization.invitation_created',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: { invitationId: created.id, role: input.role },
        },
        request,
        tx,
      );
      return created;
    });

    const locale = existingUser?.preferredLocale ?? 'en';
    this.email.sendInBackground(
      { email: input.email, name: '', preferredLocale: locale },
      {
        name: 'organization-invitation',
        organizationName: organization.name,
        role: ROLE_LABELS[locale][input.role],
        link: this.email.webLink(locale, '/invitations/accept', { token }),
      },
    );
    return {
      ...invitation,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }

  async revokeInvitation(
    organizationId: string,
    invitationId: string,
    actorId: string,
    request: Request,
  ) {
    const revoked = await this.prisma.organizationInvitation.updateMany({
      where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new AppException(ErrorCode.NOT_FOUND);
    await this.audit.recordBestEffort(
      {
        action: 'organization.invitation_revoked',
        result: 'SUCCESS',
        actorUserId: actorId,
        targetType: 'organization',
        targetId: organizationId,
        metadata: { invitationId },
      },
      request,
    );
  }

  /**
   * Accepts an invitation. The signed-in user's (verified) email must match the invited
   * address exactly, so a forwarded link cannot be used by someone else.
   */
  async accept(token: string, user: AuthenticatedUser, request: Request) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.organizationInvitation.findUnique({
        where: { tokenHash: sha256Hex(token) },
        select: {
          id: true,
          organizationId: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          invitedById: true,
          organization: { select: { name: true, isActive: true } },
        },
      });
      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitation.expiresAt <= now ||
        !invitation.organization.isActive
      ) {
        throw new AppException(ErrorCode.INVALID_TOKEN);
      }
      if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new AppException(
          ErrorCode.FORBIDDEN,
          'This invitation was sent to a different email address.',
        );
      }

      const claimed = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now, acceptedById: user.id },
      });
      if (claimed.count !== 1) throw new AppException(ErrorCode.INVALID_TOKEN);

      const existing = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
        },
        select: { status: true },
      });
      if (existing?.status === 'ACTIVE') {
        throw new AppException(ErrorCode.CONFLICT, 'You are already a member.');
      }
      await tx.organizationMember.upsert({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
        },
        create: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
          status: 'ACTIVE',
          invitedById: invitation.invitedById,
          approvedAt: now,
        },
        update: {
          role: invitation.role,
          status: 'ACTIVE',
          invitedById: invitation.invitedById,
          approvedAt: now,
        },
      });
      await this.audit.record(
        {
          action: 'organization.invitation_accepted',
          result: 'SUCCESS',
          actorUserId: user.id,
          targetType: 'organization',
          targetId: invitation.organizationId,
          metadata: { invitationId: invitation.id, role: invitation.role },
        },
        request,
        tx,
      );
      return {
        organizationId: invitation.organizationId,
        organizationName: invitation.organization.name,
        role: invitation.role,
      };
    });
  }

  async changeRole(
    organizationId: string,
    memberId: string,
    role: OrganizationRole,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const member = await this.lockedActiveMember(tx, organizationId, memberId);
      if (member.role === role) return;
      if (member.role === 'ORG_ADMIN') await this.assertNotLastAdmin(tx, organizationId);
      await tx.organizationMember.update({ where: { id: memberId }, data: { role } });
      if (member.role === 'WORKER') {
        await releaseOpenAssignments(tx, {
          organizationId,
          workerId: member.userId,
          reason: 'The worker’s role changed; the task needs a new worker.',
          actorId,
        });
      }
      await this.audit.record(
        {
          action: 'organization.member_role_changed',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: { memberId, userId: member.userId, from: member.role, to: role },
        },
        request,
        tx,
      );
    });
  }

  async removeMember(organizationId: string, memberId: string, actorId: string, request: Request) {
    await this.prisma.$transaction(async (tx) => {
      const member = await this.lockedActiveMember(tx, organizationId, memberId);
      if (member.role === 'ORG_ADMIN') await this.assertNotLastAdmin(tx, organizationId);
      await tx.organizationMember.update({ where: { id: memberId }, data: { status: 'REMOVED' } });
      // Approved policy: a departing worker's open tasks go back to the organization.
      await releaseOpenAssignments(tx, {
        organizationId,
        workerId: member.userId,
        reason: 'The worker left the organization; the task needs a new worker.',
        actorId,
      });
      await this.audit.record(
        {
          action: 'organization.member_removed',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: { memberId, userId: member.userId, role: member.role },
        },
        request,
        tx,
      );
    });
  }

  /**
   * Locks the organization row first, so concurrent role changes and removals are serialized
   * and cannot together remove the last administrator.
   */
  private async lockedActiveMember(
    tx: Prisma.TransactionClient,
    organizationId: string,
    memberId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
    const member = await tx.organizationMember.findFirst({
      where: { id: memberId, organizationId, status: 'ACTIVE' },
      select: { role: true, userId: true },
    });
    if (!member) throw new AppException(ErrorCode.NOT_FOUND);
    return member;
  }

  private async assertNotLastAdmin(tx: Prisma.TransactionClient, organizationId: string) {
    const admins = await tx.organizationMember.count({
      where: { organizationId, status: 'ACTIVE', role: 'ORG_ADMIN' },
    });
    if (admins <= 1) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'An organization must keep at least one administrator.',
      );
    }
  }
}
