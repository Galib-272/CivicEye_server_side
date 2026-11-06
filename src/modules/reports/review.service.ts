import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/http/api-response';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { MediaService } from '../media/media.service';
import { ServiceAreasService } from '../service-areas/service-areas.service';
import { canTransition } from './report-transitions';
import { applyTransition, lockReport } from './report-workflow';
import { ReportsService } from './reports.service';
import {
  QUEUE_TABS,
  type AcceptInput,
  type internalNoteSchema,
  type OrganizationReport,
  type organizationHistoryEntrySchema,
  type organizationUpdateSchema,
  type QueueQuery,
  type QueueTab,
  type queueItemSchema,
  type RejectInput,
  type TransferInput,
} from './review.schemas';

const WORKSPACE_SELECT = {
  id: true,
  publicId: true,
  organizationId: true,
  categoryId: true,
  title: true,
  description: true,
  status: true,
  latitude: true,
  longitude: true,
  locationAccuracyM: true,
  locationDescription: true,
  visibility: true,
  routingOutcome: true,
  version: true,
  submittedAt: true,
  updatedAt: true,
  category: { select: { id: true, slug: true, nameEn: true, nameBn: true } },
  organization: { select: { name: true } },
} as const;

/** Who is looking at the workspace: a reviewer of the handling organization, or a Super Admin. */
type Viewer = { kind: 'organization'; organizationId: string } | { kind: 'super_admin' };

/**
 * The organization side of a report (PRD §6.2, §7.6, §9.1): the review queue, review decisions,
 * transfers, internal notes and public updates. Callers have already checked that the user is
 * an active reviewer of `organizationId`; every method also checks that the report belongs to
 * that organization, so another organization's report looks like a missing one.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
    private readonly serviceAreas: ServiceAreasService,
    private readonly reports: ReportsService,
  ) {}

  // ─── Queue ──────────────────────────────────────────────────────────────────

  async queue(organizationId: string, query: QueueQuery) {
    const where: Prisma.ReportWhereInput = {
      organizationId,
      status: { in: [...QUEUE_TABS[query.tab]] },
      categoryId: query.categoryId,
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({
        where,
        // Oldest first: the longest-waiting reports get looked at first.
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          publicId: true,
          title: true,
          status: true,
          locationDescription: true,
          submittedAt: true,
          updatedAt: true,
          category: { select: { id: true, slug: true, nameEn: true, nameBn: true } },
          _count: { select: { media: true } },
        },
      }),
    ]);
    return new Paginated(
      rows.map((row): z.infer<typeof queueItemSchema> => ({
        publicId: row.publicId,
        title: row.title,
        category: row.category,
        status: row.status,
        locationDescription: row.locationDescription,
        photoCount: row._count.media,
        submittedAt: row.submittedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      { page: query.page, limit: query.limit, total },
    );
  }

  async queueCounts(organizationId: string): Promise<Record<QueueTab, number>> {
    const groups = await this.prisma.report.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: { _all: true },
    });
    const byStatus = new Map(groups.map((group) => [group.status, group._count._all]));
    const counts = {} as Record<QueueTab, number>;
    for (const [tab, statuses] of Object.entries(QUEUE_TABS) as Array<
      [QueueTab, readonly string[]]
    >) {
      counts[tab] = statuses.reduce((sum, value) => sum + (byStatus.get(value as never) ?? 0), 0);
    }
    return counts;
  }

  // ─── Workspace view ─────────────────────────────────────────────────────────

  async view(publicId: string, viewer: Viewer): Promise<OrganizationReport> {
    const row = await this.prisma.report.findFirst({
      where: {
        publicId,
        ...(viewer.kind === 'organization' ? { organizationId: viewer.organizationId } : {}),
      },
      select: WORKSPACE_SELECT,
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);

    const [media, requests, decision] = await Promise.all([
      this.prisma.reportMedia.findMany({
        where: { reportId: row.id },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          status: true,
          rejectionReason: true,
          displayKey: true,
          thumbnailKey: true,
        },
      }),
      this.prisma.reportInformationRequest.findMany({
        where: { reportId: row.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          message: true,
          createdAt: true,
          response: { select: { message: true, mediaIds: true, createdAt: true } },
        },
      }),
      row.status === 'REJECTED'
        ? this.prisma.reportReviewDecision.findFirst({
            where: { reportId: row.id, decision: 'REJECTED' },
            orderBy: { createdAt: 'desc' },
            select: { rejectionReason: true, publicMessage: true },
          })
        : null,
    ]);
    const photos = await Promise.all(media.map((item) => this.media.toView(item)));
    const reviewer = viewer.kind === 'organization';
    return {
      publicId: row.publicId,
      title: row.title,
      description: row.description,
      category: row.category,
      status: row.status,
      latitude: row.latitude.toNumber(),
      longitude: row.longitude.toNumber(),
      locationAccuracyM: row.locationAccuracyM,
      locationDescription: row.locationDescription,
      visibility: row.visibility,
      routing: row.routingOutcome,
      organizationId: row.organizationId,
      organizationName: row.organization?.name ?? null,
      version: row.version,
      submittedAt: row.submittedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      photos: photos.map(({ id, thumbnailUrl, displayUrl }) => ({ id, thumbnailUrl, displayUrl })),
      informationRequests: requests.map((request) => ({
        id: request.id,
        message: request.message,
        requestedAt: request.createdAt.toISOString(),
        response: request.response
          ? {
              message: request.response.message,
              photoCount: request.response.mediaIds.length,
              respondedAt: request.response.createdAt.toISOString(),
            }
          : null,
      })),
      rejection:
        decision?.rejectionReason && decision.publicMessage
          ? { reason: decision.rejectionReason, message: decision.publicMessage }
          : null,
      // Super Admins can look (audited) but do not review on an organization's behalf.
      actions: {
        startReview: reviewer && canTransition('startReview', row.status, 'org_reviewer'),
        requestInformation:
          reviewer && canTransition('requestInformation', row.status, 'org_reviewer'),
        accept: reviewer && canTransition('accept', row.status, 'org_reviewer'),
        reject: reviewer && canTransition('reject', row.status, 'org_reviewer'),
        transfer: reviewer && canTransition('transfer', row.status, 'org_reviewer'),
      },
    };
  }

  /** Super Admin view of any report. Every look is audited (PRD §15: "Authorized"). */
  async adminView(publicId: string, actorId: string, request: Request) {
    const reportId = await this.reportId(publicId, { kind: 'super_admin' });
    await this.audit.record(
      {
        action: 'report.viewed_by_admin',
        result: 'SUCCESS',
        actorUserId: actorId,
        targetType: 'report',
        targetId: reportId,
      },
      request,
    );
    return this.view(publicId, { kind: 'super_admin' });
  }

  async history(publicId: string, viewer: Viewer) {
    await this.reportId(publicId, viewer);
    const entries = await this.prisma.reportStatusHistory.findMany({
      where: { report: { publicId } },
      orderBy: { createdAt: 'asc' },
      select: {
        fromStatus: true,
        toStatus: true,
        actorContext: true,
        reason: true,
        publicMessage: true,
        createdAt: true,
      },
    });
    return entries.map((entry): z.infer<typeof organizationHistoryEntrySchema> => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  // ─── Review decisions ───────────────────────────────────────────────────────

  async startReview(
    organizationId: string,
    publicId: string,
    version: number,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      await applyTransition(tx, report, 'startReview', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
      });
      await this.record(tx, request, actorId, report.id, 'report.review_started', {
        organizationId,
      });
    });
    return this.view(publicId, { kind: 'organization', organizationId });
  }

  async requestInformation(
    organizationId: string,
    publicId: string,
    version: number,
    message: string,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      await applyTransition(tx, report, 'requestInformation', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        // The citizen sees the request as the reason; it is not public.
        reason: message,
      });
      await tx.reportInformationRequest.create({
        data: { reportId: report.id, organizationId, requestedById: actorId, message },
      });
      await this.record(tx, request, actorId, report.id, 'report.information_requested', {
        organizationId,
      });
    });
    return this.view(publicId, { kind: 'organization', organizationId });
  }

  /**
   * Approved acceptance rule: the final category must be one the organization handles, and the
   * location must be in its service area — unless a Super Admin or a transfer explicitly sent
   * the report here.
   */
  async accept(
    organizationId: string,
    publicId: string,
    version: number,
    input: AcceptInput,
    actorId: string,
    request: Request,
  ) {
    if (input.categoryId) await this.reports.assertActiveCategory(input.categoryId);
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      const categoryId = input.categoryId ?? report.categoryId;
      const handles = await tx.organizationCategory.findUnique({
        where: { organizationId_categoryId: { organizationId, categoryId } },
        select: { organizationId: true },
      });
      if (!handles) {
        throw new AppException(
          ErrorCode.ORGANIZATION_NOT_ELIGIBLE,
          'Your organization does not handle this category. Choose one it handles, or transfer the report.',
        );
      }
      if (report.routingOutcome === 'ROUTED') {
        const covering = await this.serviceAreas.organizationsCovering(
          report.latitude.toNumber(),
          report.longitude.toNumber(),
        );
        if (!covering.some((organization) => organization.id === organizationId)) {
          throw new AppException(
            ErrorCode.ORGANIZATION_NOT_ELIGIBLE,
            'The location is outside your service areas. Transfer the report instead.',
          );
        }
      }
      const corrected = categoryId !== report.categoryId;
      await applyTransition(tx, report, 'accept', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        publicMessage: input.publicMessage ?? null,
        data: { categoryId, reviewedAt: new Date() },
      });
      await tx.reportReviewDecision.create({
        data: {
          reportId: report.id,
          organizationId,
          reviewerId: actorId,
          decision: 'ACCEPTED',
          publicMessage: input.publicMessage ?? null,
          categoryFromId: corrected ? report.categoryId : null,
          categoryToId: corrected ? categoryId : null,
        },
      });
      await this.record(tx, request, actorId, report.id, 'report.accepted', {
        organizationId,
        categoryCorrected: corrected,
      });
    });
    return this.view(publicId, { kind: 'organization', organizationId });
  }

  async reject(
    organizationId: string,
    publicId: string,
    version: number,
    input: RejectInput,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      await applyTransition(tx, report, 'reject', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason: input.reason,
        publicMessage: input.message,
        data: { reviewedAt: new Date() },
      });
      await tx.reportReviewDecision.create({
        data: {
          reportId: report.id,
          organizationId,
          reviewerId: actorId,
          decision: 'REJECTED',
          rejectionReason: input.reason,
          publicMessage: input.message,
        },
      });
      await this.record(tx, request, actorId, report.id, 'report.rejected', {
        organizationId,
        reason: input.reason,
      });
    });
    return this.view(publicId, { kind: 'organization', organizationId });
  }

  // ─── Transfers ──────────────────────────────────────────────────────────────

  /** Verified organizations (other than this one) that cover the location and handle the category. */
  async transferTargets(organizationId: string, publicId: string) {
    const report = await this.prisma.report.findFirst({
      where: { publicId, organizationId },
      select: { latitude: true, longitude: true, categoryId: true },
    });
    if (!report) throw new AppException(ErrorCode.NOT_FOUND);
    const covering = await this.serviceAreas.organizationsCovering(
      report.latitude.toNumber(),
      report.longitude.toNumber(),
      report.categoryId,
    );
    return covering.filter((organization) => organization.id !== organizationId);
  }

  /**
   * Approved transfer policy: the report restarts at SUBMITTED with an eligible organization
   * (verified, covering the location, handling the category), or goes back to Super Admin
   * triage. The previous organization loses access; the history keeps the move.
   */
  async transfer(
    organizationId: string,
    publicId: string,
    version: number,
    input: TransferInput,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      const target = input.toOrganizationId;
      if (target !== null) {
        if (target === organizationId) {
          throw new AppException(ErrorCode.VALIDATION_ERROR, 'Choose a different organization.');
        }
        const eligible = await this.serviceAreas.organizationsCovering(
          report.latitude.toNumber(),
          report.longitude.toNumber(),
          report.categoryId,
        );
        if (!eligible.some((organization) => organization.id === target)) {
          throw new AppException(
            ErrorCode.ORGANIZATION_NOT_ELIGIBLE,
            'That organization does not cover this location and category. Send the report back to CivicEye instead.',
          );
        }
      }
      await applyTransition(tx, report, 'transfer', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason: input.reason,
        data: {
          organizationId: target,
          routingOutcome: target === null ? 'UNROUTED' : 'TRANSFERRED',
          reviewedAt: null,
        },
      });
      await tx.reportTransfer.create({
        data: {
          reportId: report.id,
          fromOrganizationId: organizationId,
          toOrganizationId: target,
          actorId,
          fromStatus: report.status,
          reason: input.reason,
        },
      });
      await tx.reportRoutingDecision.create({
        data: {
          reportId: report.id,
          outcome: target === null ? 'UNROUTED' : 'TRANSFERRED',
          organizationId: target,
          candidates: [],
          rule: target === null ? 'returned_to_triage' : 'organization_transfer',
          decidedById: actorId,
          reason: input.reason,
        },
      });
      await this.record(tx, request, actorId, report.id, 'report.transferred', {
        fromOrganizationId: organizationId,
        toOrganizationId: target,
      });
    });
  }

  // ─── Internal notes ─────────────────────────────────────────────────────────

  /** This organization's notes only; Super Admins see every organization's notes. */
  async notes(publicId: string, viewer: Viewer) {
    const reportId = await this.reportId(publicId, viewer);
    const notes = await this.prisma.reportInternalNote.findMany({
      where: {
        reportId,
        ...(viewer.kind === 'organization' ? { organizationId: viewer.organizationId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { name: true } },
        organization: { select: { name: true } },
      },
    });
    return notes.map((note): z.infer<typeof internalNoteSchema> => ({
      id: note.id,
      body: note.body,
      authorName: note.author.name,
      organizationName: note.organization.name,
      createdAt: note.createdAt.toISOString(),
    }));
  }

  async addNote(organizationId: string, publicId: string, body: string, authorId: string) {
    const reportId = await this.reportId(publicId, { kind: 'organization', organizationId });
    await this.prisma.reportInternalNote.create({
      data: { reportId, organizationId, authorId, body },
    });
    return this.notes(publicId, { kind: 'organization', organizationId });
  }

  // ─── Public updates ─────────────────────────────────────────────────────────

  async updates(publicId: string, viewer: Viewer) {
    const reportId = await this.reportId(publicId, viewer);
    const updates = await this.prisma.reportPublicUpdate.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        body: true,
        createdAt: true,
        hiddenAt: true,
        hiddenReason: true,
        author: { select: { name: true } },
        organization: { select: { name: true } },
      },
    });
    return updates.map((update): z.infer<typeof organizationUpdateSchema> => ({
      id: update.id,
      body: update.body,
      authorName: update.author.name,
      organizationName: update.organization.name,
      createdAt: update.createdAt.toISOString(),
      hidden: update.hiddenAt !== null,
      hiddenReason: update.hiddenReason,
    }));
  }

  async addUpdate(
    organizationId: string,
    publicId: string,
    body: string,
    authorId: string,
    request: Request,
  ) {
    const reportId = await this.reportId(publicId, { kind: 'organization', organizationId });
    await this.prisma.$transaction(async (tx) => {
      await tx.reportPublicUpdate.create({ data: { reportId, organizationId, authorId, body } });
      await this.record(tx, request, authorId, reportId, 'report.update_posted', {
        organizationId,
      });
    });
    return this.updates(publicId, { kind: 'organization', organizationId });
  }

  /** Super Admin moderation: hides an update from citizens and the public, with a reason. */
  async hideUpdate(updateId: string, reason: string, actorId: string, request: Request) {
    await this.prisma.$transaction(async (tx) => {
      const hidden = await tx.reportPublicUpdate.updateMany({
        where: { id: updateId, hiddenAt: null },
        data: { hiddenAt: new Date(), hiddenById: actorId, hiddenReason: reason },
      });
      if (hidden.count !== 1) throw new AppException(ErrorCode.NOT_FOUND);
      await this.audit.record(
        {
          action: 'report.update_hidden',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'report_public_update',
          targetId: updateId,
          reason,
        },
        request,
        tx,
      );
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async lockForOrganization(
    tx: Prisma.TransactionClient,
    publicId: string,
    organizationId: string,
  ) {
    const id = await lockReport(tx, publicId, { organizationId });
    return tx.report.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        status: true,
        version: true,
        categoryId: true,
        latitude: true,
        longitude: true,
        routingOutcome: true,
      },
    });
  }

  /** The report's internal ID, or NOT_FOUND when the viewer may not see it. */
  private async reportId(publicId: string, viewer: Viewer): Promise<string> {
    const row = await this.prisma.report.findFirst({
      where: {
        publicId,
        ...(viewer.kind === 'organization' ? { organizationId: viewer.organizationId } : {}),
      },
      select: { id: true },
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row.id;
  }

  private record(
    tx: Prisma.TransactionClient,
    request: Request,
    actorUserId: string,
    reportId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        action,
        result: 'SUCCESS',
        actorUserId,
        targetType: 'report',
        targetId: reportId,
        metadata: metadata as Prisma.InputJsonValue,
      },
      request,
      tx,
    );
  }
}
