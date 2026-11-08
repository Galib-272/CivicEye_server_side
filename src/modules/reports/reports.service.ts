import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { randomInt, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/http/api-response';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { ReportStatus, RoutingOutcome } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth-context';
import { AuthLimits, AuthRateLimiter } from '../auth/auth-rate-limiter.service';
import { PHOTO_LIMITS } from '../media/image-processing';
import { MediaService } from '../media/media.service';
import { ServiceAreasService } from '../service-areas/service-areas.service';
import { canTransition, EDITABLE_STATUSES } from './report-transitions';
import { recordEvent } from '../notifications/outbox';
import { AiService } from '../ai/ai.service';
import { refreshDuplicateCandidates } from './duplicates';
import { applyTransition, lockReport } from './report-workflow';
import type {
  CreateReportInput,
  historyEntrySchema,
  ownReportSchema,
  ProvideInformationInput,
  publicUpdateSchema,
  PublicReportsQuery,
  publicReportSchema,
  triageItemSchema,
  UpdateReportInput,
} from './reports.schemas';

// Crockford base32 without I, L, O, U: unambiguous when read aloud or typed.
const PUBLIC_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generatePublicId(): string {
  const chars = Array.from(
    { length: 8 },
    () => PUBLIC_ID_ALPHABET[randomInt(PUBLIC_ID_ALPHABET.length)],
  );
  return `CE-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Public precision (approved): 3 decimal places, about 110 m of latitude. */
export function roundForPublic(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export const REPORT_SELECT = {
  id: true,
  publicId: true,
  citizenId: true,
  organizationId: true,
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
  resolvedAt: true,
  updatedAt: true,
  category: { select: { id: true, slug: true, nameEn: true, nameBn: true } },
  organization: { select: { name: true } },
  _count: { select: { media: true } },
} as const;

export type ReportRow = Prisma.ReportGetPayload<{ select: typeof REPORT_SELECT }>;

/** Reports a member of the public may see: public, and not withdrawn by the citizen. */
const PUBLICLY_VISIBLE: Prisma.ReportWhereInput = {
  visibility: 'PUBLIC',
  status: { notIn: ['WITHDRAWN'] },
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly limiter: AuthRateLimiter,
    private readonly media: MediaService,
    private readonly serviceAreas: ServiceAreasService,
    private readonly ai: AiService,
  ) {}

  // ─── Views ──────────────────────────────────────────────────────────────────

  toPublic(row: ReportRow): z.infer<typeof publicReportSchema> {
    return {
      publicId: row.publicId,
      title: row.title,
      description: row.description,
      category: row.category,
      status: row.status,
      latitude: roundForPublic(row.latitude.toNumber()),
      longitude: roundForPublic(row.longitude.toNumber()),
      locationDescription: row.locationDescription,
      organizationName: row.organization?.name ?? null,
      photoCount: row._count.media,
      submittedAt: row.submittedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async toOwn(row: ReportRow): Promise<z.infer<typeof ownReportSchema>> {
    const media = await this.prisma.reportMedia.findMany({
      where: { reportId: row.id },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        displayKey: true,
        thumbnailKey: true,
      },
    });
    const photos = await Promise.all(media.map((item) => this.media.toView(item)));
    const [request, decision, completion, feedback] = await Promise.all([
      row.status === 'NEEDS_INFORMATION'
        ? this.prisma.reportInformationRequest.findFirst({
            where: { reportId: row.id, response: null },
            orderBy: { createdAt: 'desc' },
            select: { message: true, createdAt: true },
          })
        : null,
      row.status === 'REJECTED'
        ? this.prisma.reportReviewDecision.findFirst({
            where: { reportId: row.id, decision: 'REJECTED' },
            orderBy: { createdAt: 'desc' },
            select: { rejectionReason: true, publicMessage: true },
          })
        : null,
      this.completion(row),
      row.status === 'RESOLVED' && row.resolvedAt
        ? this.prisma.citizenFeedback.findFirst({
            where: { reportId: row.id, createdAt: { gte: row.resolvedAt } },
            orderBy: { createdAt: 'desc' },
            select: { fixed: true, comment: true },
          })
        : null,
    ]);
    return {
      ...this.toPublic(row),
      // The citizen sees their own exact location.
      latitude: row.latitude.toNumber(),
      longitude: row.longitude.toNumber(),
      visibility: row.visibility,
      locationAccuracyM: row.locationAccuracyM,
      routing: row.routingOutcome,
      version: row.version,
      canEdit: EDITABLE_STATUSES.has(row.status),
      canWithdraw: canTransition('withdraw', row.status, 'owner'),
      canProvideInformation:
        request !== null && canTransition('provideInformation', row.status, 'owner'),
      informationRequest: request
        ? { message: request.message, requestedAt: request.createdAt.toISOString() }
        : null,
      rejection:
        decision?.rejectionReason && decision.publicMessage
          ? { reason: decision.rejectionReason, message: decision.publicMessage }
          : null,
      photos: photos.map(({ id, thumbnailUrl, displayUrl }) => ({ id, thumbnailUrl, displayUrl })),
      completion,
      canGiveFeedback: row.status === 'RESOLVED' && feedback === null,
      duplicateOf: row.status === 'DUPLICATE' ? await this.duplicateOf(row.id) : null,
      feedback,
    };
  }

  /** The original of a duplicate, named only if it is public and not withdrawn. */
  private async duplicateOf(reportId: string) {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
      select: { duplicateOf: { select: { publicId: true, visibility: true, status: true } } },
    });
    const original = report?.duplicateOf;
    return {
      publicId:
        original && original.visibility === 'PUBLIC' && original.status !== 'WITHDRAWN'
          ? original.publicId
          : null,
    };
  }

  /** What the organization verified as the fix (description and after photos). */
  private async completion(row: ReportRow) {
    if ((row.status !== 'RESOLVED' && row.status !== 'CLOSED') || !row.resolvedAt) return null;
    const approved = await this.prisma.workVerification.findFirst({
      where: { reportId: row.id, outcome: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      select: { submission: { select: { description: true, mediaIds: true } } },
    });
    if (!approved) return null;
    const media = await this.prisma.reportMedia.findMany({
      where: { id: { in: approved.submission.mediaIds } },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        displayKey: true,
        thumbnailKey: true,
      },
    });
    const photos = await Promise.all(media.map((item) => this.media.toView(item)));
    return {
      description: approved.submission.description,
      photos: photos.map(({ id, thumbnailUrl, displayUrl }) => ({ id, thumbnailUrl, displayUrl })),
      resolvedAt: row.resolvedAt.toISOString(),
    };
  }

  /**
   * One report for whoever is asking: the full view for its citizen, otherwise the public view
   * if it is publicly visible. Anything else is NOT_FOUND; organizations use their own workspace view.
   */
  async findForViewer(publicId: string, viewer: AuthenticatedUser | undefined) {
    const row = await this.prisma.report.findUnique({ where: { publicId }, select: REPORT_SELECT });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    if (viewer && row.citizenId === viewer.id) {
      return { kind: 'own' as const, report: await this.toOwn(row) };
    }
    if (row.visibility === 'PUBLIC' && row.status !== 'WITHDRAWN') {
      return { kind: 'public' as const, report: this.toPublic(row) };
    }
    throw new AppException(ErrorCode.NOT_FOUND);
  }

  async history(publicId: string, viewer: AuthenticatedUser | undefined) {
    const { kind } = await this.findForViewer(publicId, viewer);
    const entries = await this.prisma.reportStatusHistory.findMany({
      where: { report: { publicId } },
      orderBy: { createdAt: 'asc' },
      select: {
        fromStatus: true,
        toStatus: true,
        publicMessage: true,
        reason: true,
        createdAt: true,
      },
    });
    return entries.map((entry): z.infer<typeof historyEntrySchema> => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      publicMessage: entry.publicMessage,
      reason: kind === 'own' ? entry.reason : null,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  async mine(citizenId: string, query: { page: number; limit: number; status?: ReportStatus }) {
    const where: Prisma.ReportWhereInput = { citizenId, status: query.status };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({
        where,
        select: REPORT_SELECT,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return new Paginated(
      rows.map((row) => ({
        ...this.toPublic(row),
        latitude: row.latitude.toNumber(),
        longitude: row.longitude.toNumber(),
      })),
      { page: query.page, limit: query.limit, total },
    );
  }

  async mySummary(citizenId: string) {
    const groups = await this.prisma.report.groupBy({
      by: ['status'],
      where: { citizenId },
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
    return { total: groups.reduce((sum, group) => sum + group._count._all, 0), byStatus };
  }

  async publicList(query: PublicReportsQuery) {
    // Withdrawn reports are never public.
    if (query.status === 'WITHDRAWN') {
      return new Paginated([], { page: query.page, limit: query.limit, total: 0 });
    }
    const where: Prisma.ReportWhereInput = {
      AND: [PUBLICLY_VISIBLE, query.status ? { status: query.status } : {}],
      categoryId: query.categoryId,
      submittedAt: {
        gte: query.from ? new Date(`${query.from}T00:00:00Z`) : undefined,
        lt: query.to
          ? new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000)
          : undefined,
      },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({
        where,
        select: REPORT_SELECT,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return new Paginated(
      rows.map((row) => this.toPublic(row)),
      {
        page: query.page,
        limit: query.limit,
        total,
      },
    );
  }

  // ─── Submission ─────────────────────────────────────────────────────────────

  /** Submits a report and returns its public ID. */
  async create(
    input: CreateReportInput,
    citizen: AuthenticatedUser,
    request: Request,
  ): Promise<string> {
    await this.limiter.consume(AuthLimits.reportsPerUserHour, citizen.id);
    await this.limiter.consume(AuthLimits.reportsPerUserDay, citizen.id);
    await this.assertActiveCategory(input.categoryId);

    const mediaIds = [...new Set(input.mediaIds)];
    const media = await this.prisma.reportMedia.findMany({
      where: {
        id: { in: mediaIds },
        uploaderId: citizen.id,
        reportId: null,
        assignmentId: null,
        purpose: 'REPORT_PHOTO',
      },
      select: { id: true, status: true },
    });
    if (media.length !== mediaIds.length) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'mediaIds', message: 'One or more photos were not found or are already used.' },
      ]);
    }
    if (media.some((item) => item.status !== 'PROCESSED')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        {
          field: 'mediaIds',
          message: 'Wait until every photo has finished processing, and remove rejected photos.',
        },
      ]);
    }

    const latitude = Number(input.latitude.toFixed(6));
    const longitude = Number(input.longitude.toFixed(6));
    const routing = await this.route(latitude, longitude, input.categoryId);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomUUID();
      const publicId = generatePublicId();
      try {
        const analyses = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO reports (id, public_id, citizen_id, organization_id, category_id, title,
              description, status, location, latitude, longitude, location_accuracy_m,
              location_description, visibility, routing_outcome, updated_at)
            VALUES (${id}::uuid, ${publicId}, ${citizen.id}::uuid, ${routing.organizationId}::uuid,
              ${input.categoryId}::uuid, ${input.title}, ${input.description},
              'SUBMITTED'::"ReportStatus",
              ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
              ${latitude}, ${longitude}, ${input.locationAccuracyM ?? null},
              ${input.locationDescription ?? null}, ${input.visibility}::"ReportVisibility",
              ${routing.outcome}::"RoutingOutcome", now())`;
          await tx.reportStatusHistory.create({
            data: {
              reportId: id,
              fromStatus: null,
              toStatus: 'SUBMITTED',
              actorUserId: citizen.id,
              actorContext: 'citizen',
            },
          });
          await tx.reportRoutingDecision.create({
            data: {
              reportId: id,
              outcome: routing.outcome,
              organizationId: routing.organizationId,
              candidates: routing.candidates,
              rule: 'single_covering_verified_organization',
            },
          });
          for (const [position, mediaId] of mediaIds.entries()) {
            const attached = await tx.reportMedia.updateMany({
              where: {
                id: mediaId,
                uploaderId: citizen.id,
                reportId: null,
                assignmentId: null,
                purpose: 'REPORT_PHOTO',
                status: 'PROCESSED',
              },
              data: { reportId: id, position },
            });
            if (attached.count !== 1) {
              throw new AppException(ErrorCode.CONFLICT, 'A photo was used by another submission.');
            }
          }
          await refreshDuplicateCandidates(tx, id);
          await recordEvent(tx, 'report.submitted', { reportId: id });
          await this.audit.record(
            {
              action: 'report.submitted',
              result: 'SUCCESS',
              actorUserId: citizen.id,
              targetType: 'report',
              targetId: id,
              metadata: { publicId, routing: routing.outcome, photos: mediaIds.length },
            },
            request,
            tx,
          );
          return this.ai.recordPending(tx, id, mediaIds);
        });
        // Advisory only: queued after commit, and never able to fail the submission.
        await this.ai.enqueue(analyses);
        return publicId;
      } catch (error) {
        // Retry only on the (very unlikely) public ID collision.
        if (error instanceof Error && error.message.includes('reports_public_id_key')) continue;
        throw error;
      }
    }
    throw new AppException(ErrorCode.INTERNAL_ERROR);
  }

  /**
   * Approved routing rule: a report goes to an organization only when exactly one verified,
   * active organization handling the category covers the point. None or several → triage.
   */
  private async route(latitude: number, longitude: number, categoryId: string) {
    const candidates = await this.serviceAreas.organizationsCovering(
      latitude,
      longitude,
      categoryId,
    );
    const outcome: RoutingOutcome =
      candidates.length === 1 ? 'ROUTED' : candidates.length === 0 ? 'UNROUTED' : 'AMBIGUOUS';
    return {
      outcome,
      organizationId: candidates.length === 1 ? (candidates[0]?.id ?? null) : null,
      candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name })),
    };
  }

  // ─── Changes by the citizen ─────────────────────────────────────────────────

  async update(
    publicId: string,
    input: UpdateReportInput,
    expectedVersion: number,
    citizen: AuthenticatedUser,
    request: Request,
  ) {
    if (input.categoryId) await this.assertActiveCategory(input.categoryId);

    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwned(tx, publicId, citizen.id);
      if (!EDITABLE_STATUSES.has(current.status)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'This report can no longer be edited.',
        );
      }
      if (current.version !== expectedVersion) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'The report was changed elsewhere. Reload it and try again.',
        );
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const scalar = {
        title: input.title,
        description: input.description,
        categoryId: input.categoryId,
        locationAccuracyM: input.locationAccuracyM,
        locationDescription: input.locationDescription,
        visibility: input.visibility,
      } as const;
      for (const [field, value] of Object.entries(scalar)) {
        const before = current[field as keyof typeof scalar];
        if (value !== undefined && value !== before) changes[field] = { from: before, to: value };
      }
      const latitude = input.latitude !== undefined ? Number(input.latitude.toFixed(6)) : undefined;
      const longitude =
        input.longitude !== undefined ? Number(input.longitude.toFixed(6)) : undefined;
      const moved =
        latitude !== undefined &&
        longitude !== undefined &&
        (latitude !== current.latitude.toNumber() || longitude !== current.longitude.toNumber());
      if (moved) {
        changes['location'] = {
          from: [current.latitude.toNumber(), current.longitude.toNumber()],
          to: [latitude, longitude],
        };
      }
      if (Object.keys(changes).length === 0) return;

      const nextVersion = current.version + 1;
      await tx.report.update({
        where: { id: current.id },
        data: {
          ...Object.fromEntries(Object.entries(scalar).filter(([, value]) => value !== undefined)),
          version: nextVersion,
        },
      });
      if (moved) {
        await tx.$executeRaw`
          UPDATE reports
          SET location = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
              latitude = ${latitude}, longitude = ${longitude}
          WHERE id = ${current.id}::uuid`;
      }
      if (moved || changes['categoryId']) {
        // Still SUBMITTED, so a new location or category means routing again.
        const routing = await this.route(
          latitude ?? current.latitude.toNumber(),
          longitude ?? current.longitude.toNumber(),
          input.categoryId ?? current.categoryId,
        );
        await tx.report.update({
          where: { id: current.id },
          data: { organizationId: routing.organizationId, routingOutcome: routing.outcome },
        });
        await tx.reportRoutingDecision.create({
          data: {
            reportId: current.id,
            outcome: routing.outcome,
            organizationId: routing.organizationId,
            candidates: routing.candidates,
            rule: 'single_covering_verified_organization',
            reason: 'Report edited by the citizen',
          },
        });
        // A new place or category means new duplicate candidates.
        await refreshDuplicateCandidates(tx, current.id);
      }
      await tx.reportEdit.create({
        data: {
          reportId: current.id,
          editorId: citizen.id,
          version: nextVersion,
          changes: changes as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        {
          action: 'report.edited',
          result: 'SUCCESS',
          actorUserId: citizen.id,
          targetType: 'report',
          targetId: current.id,
          metadata: { fields: Object.keys(changes), version: nextVersion },
        },
        request,
        tx,
      );
    });
    return this.findForViewer(publicId, citizen).then((result) => result.report);
  }

  async withdraw(publicId: string, reason: string, citizen: AuthenticatedUser, request: Request) {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwned(tx, publicId, citizen.id);
      await applyTransition(tx, current, 'withdraw', 'owner', {
        actorUserId: citizen.id,
        actorContext: 'citizen',
        reason,
      });
      await this.audit.record(
        {
          action: 'report.withdrawn',
          result: 'SUCCESS',
          actorUserId: citizen.id,
          targetType: 'report',
          targetId: current.id,
          reason,
        },
        request,
        tx,
      );
    });
    return this.findForViewer(publicId, citizen).then((result) => result.report);
  }

  /**
   * The citizen answers the open information request, optionally adding photos (5 in total),
   * which sends the report back to the organization's review.
   */
  async provideInformation(
    publicId: string,
    input: ProvideInformationInput,
    citizen: AuthenticatedUser,
    request: Request,
  ) {
    const mediaIds = [...new Set(input.mediaIds)];
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwned(tx, publicId, citizen.id);
      const open = await tx.reportInformationRequest.findFirst({
        where: { reportId: current.id, response: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!open || current.status !== 'NEEDS_INFORMATION') {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'No information has been requested for this report.',
        );
      }
      const attached = await tx.reportMedia.count({ where: { reportId: current.id } });
      if (attached + mediaIds.length > PHOTO_LIMITS.maxPerReport) {
        throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
          {
            field: 'mediaIds',
            message: `A report can have at most ${PHOTO_LIMITS.maxPerReport} photos.`,
          },
        ]);
      }
      for (const [offset, mediaId] of mediaIds.entries()) {
        const updated = await tx.reportMedia.updateMany({
          where: {
            id: mediaId,
            uploaderId: citizen.id,
            reportId: null,
            assignmentId: null,
            purpose: 'REPORT_PHOTO',
            status: 'PROCESSED',
          },
          data: { reportId: current.id, position: attached + offset },
        });
        if (updated.count !== 1) {
          throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
            {
              field: 'mediaIds',
              message: 'A photo was not found, is still being checked, or is already used.',
            },
          ]);
        }
      }
      await tx.reportInformationResponse.create({
        data: { requestId: open.id, respondedById: citizen.id, message: input.message, mediaIds },
      });
      await applyTransition(tx, current, 'provideInformation', 'owner', {
        actorUserId: citizen.id,
        actorContext: 'citizen',
      });
      await this.audit.record(
        {
          action: 'report.information_provided',
          result: 'SUCCESS',
          actorUserId: citizen.id,
          targetType: 'report',
          targetId: current.id,
          metadata: { photos: mediaIds.length },
        },
        request,
        tx,
      );
    });
    return this.findForViewer(publicId, citizen).then((result) => result.report);
  }

  /** Organization updates for anyone who may see the report. Hidden updates are left out. */
  async publicUpdates(publicId: string, viewer: AuthenticatedUser | undefined) {
    await this.findForViewer(publicId, viewer);
    const updates = await this.prisma.reportPublicUpdate.findMany({
      where: { report: { publicId }, hiddenAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, body: true, createdAt: true, organization: { select: { name: true } } },
    });
    return updates.map((update): z.infer<typeof publicUpdateSchema> => ({
      id: update.id,
      organizationName: update.organization.name,
      body: update.body,
      createdAt: update.createdAt.toISOString(),
    }));
  }

  // ─── Super Admin triage ─────────────────────────────────────────────────────

  async triage(query: { page: number; limit: number }) {
    const where: Prisma.ReportWhereInput = {
      status: 'SUBMITTED',
      organizationId: null,
      routingOutcome: { in: ['UNROUTED', 'AMBIGUOUS'] },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({
        where,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          ...REPORT_SELECT,
          routingDecisions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { candidates: true, reason: true },
          },
        },
      }),
    ]);
    return new Paginated(
      rows.map((row): z.infer<typeof triageItemSchema> => ({
        publicId: row.publicId,
        title: row.title,
        category: row.category,
        status: row.status,
        routing: row.routingOutcome === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNROUTED',
        candidates: (row.routingDecisions[0]?.candidates ?? []) as Array<{
          id: string;
          name: string;
        }>,
        note: row.routingDecisions[0]?.reason ?? null,
        latitude: row.latitude.toNumber(),
        longitude: row.longitude.toNumber(),
        locationDescription: row.locationDescription,
        submittedAt: row.submittedAt.toISOString(),
      })),
      { page: query.page, limit: query.limit, total },
    );
  }

  /** A Super Admin assigns a triaged report to a verified organization, with a reason. */
  async routeManually(
    publicId: string,
    organizationId: string,
    reason: string,
    actorId: string,
    request: Request,
  ) {
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, verificationState: 'VERIFIED', isActive: true },
      select: { id: true },
    });
    if (!organization) {
      throw new AppException(
        ErrorCode.ORGANIZATION_NOT_ELIGIBLE,
        'Only verified, active organizations can receive reports.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM reports WHERE public_id = ${publicId} FOR UPDATE`;
      if (!locked) throw new AppException(ErrorCode.NOT_FOUND);
      const report = await tx.report.findUniqueOrThrow({
        where: { id: locked.id },
        select: { id: true, status: true, organizationId: true, version: true },
      });
      if (report.status !== 'SUBMITTED' || report.organizationId !== null) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Only unassigned, submitted reports can be routed.',
        );
      }
      await tx.report.update({
        where: { id: report.id },
        data: { organizationId, routingOutcome: 'MANUAL', version: report.version + 1 },
      });
      await tx.reportRoutingDecision.create({
        data: {
          reportId: report.id,
          outcome: 'MANUAL',
          organizationId,
          candidates: [],
          rule: 'super_admin_triage',
          decidedById: actorId,
          reason,
        },
      });
      await recordEvent(tx, 'report.routed', {
        reportId: report.id,
        organizationId,
        actorUserId: actorId,
      });
      await this.audit.record(
        {
          action: 'report.routed_manually',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'report',
          targetId: report.id,
          reason,
          metadata: { organizationId },
        },
        request,
        tx,
      );
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Locks the citizen's own report row; another citizen's report looks like a missing one. */
  private async lockOwned(tx: Prisma.TransactionClient, publicId: string, citizenId: string) {
    const id = await lockReport(tx, publicId, { citizenId });
    return tx.report.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        status: true,
        version: true,
        title: true,
        description: true,
        categoryId: true,
        latitude: true,
        longitude: true,
        locationAccuracyM: true,
        locationDescription: true,
        visibility: true,
      },
    });
  }

  async assertActiveCategory(categoryId: string): Promise<void> {
    const category = await this.prisma.reportCategory.findFirst({
      where: {
        id: categoryId,
        isActive: true,
        OR: [{ parentId: null }, { parent: { isActive: true } }],
      },
      select: { id: true },
    });
    if (!category) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'categoryId', message: 'Choose an active category.' },
      ]);
    }
  }
}
