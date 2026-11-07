import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import type { ReportStatus } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import { AssignmentViews } from './assignment-views.service';
import { applyTransition, lockReport } from './report-workflow';
import { category, photo, publicIdSchema, status } from './reports.schemas';
import { ReviewService } from './review.service';

export const nearbyQuerySchema = z.strictObject({
  radius: z.coerce.number().int().min(50).max(1000).default(200),
});

export const markDuplicateSchema = z.strictObject({
  canonicalPublicId: publicIdSchema,
  reason: z.string().trim().min(10).max(1000),
});
export type MarkDuplicateInput = z.infer<typeof markDuplicateSchema>;

export const dismissDuplicateSchema = z.strictObject({
  candidatePublicId: publicIdSchema,
  reason: z.string().trim().min(1).max(1000).optional(),
});
export type DismissDuplicateInput = z.infer<typeof dismissDuplicateSchema>;

/** Another report of the same organization, as shown next to the one being reviewed. */
export const relatedReportSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  status,
  category,
  distanceM: z.number().int(),
  submittedAt: z.iso.datetime(),
  photos: z.array(photo),
});
type RelatedReport = z.infer<typeof relatedReportSchema>;

/** Reports that can never be the original of a duplicate. */
const NOT_CANONICAL: ReportStatus[] = ['DUPLICATE', 'WITHDRAWN', 'REJECTED'];

interface RelatedRow {
  id: string;
  public_id: string;
  title: string;
  status: ReportStatus;
  category_id: string;
  distance_m: number;
  submitted_at: Date;
}

/**
 * Duplicate review for the organization handling a report (PRD §10.5, §6.3): candidate lists,
 * a free nearby search, and linking a report to its original. Reviewers only ever see and link
 * reports of their own organization; a duplicate of another organization's report is a
 * transfer instead.
 */
@Injectable()
export class DuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly views: AssignmentViews,
    private readonly review: ReviewService,
  ) {}

  /** Pending candidates in either direction that the same organization handles. */
  async candidates(organizationId: string, publicId: string): Promise<RelatedReport[]> {
    const report = await this.ownReport(organizationId, publicId);
    const rows = await this.prisma.$queryRaw<RelatedRow[]>`
      SELECT o.id, o.public_id, o.title, o.status, o.category_id,
             round(d.distance_m)::int AS distance_m, o.submitted_at
      FROM duplicate_candidates d
      JOIN reports o ON o.id = CASE WHEN d.report_id = ${report.id}::uuid
                                    THEN d.candidate_id ELSE d.report_id END
      WHERE (d.report_id = ${report.id}::uuid OR d.candidate_id = ${report.id}::uuid)
        AND d.status = 'PENDING'
        AND o.organization_id = ${organizationId}::uuid
        AND o.status NOT IN ('DUPLICATE', 'WITHDRAWN', 'REJECTED')
      ORDER BY d.distance_m ASC, o.submitted_at ASC
      LIMIT 20`;
    return this.present(rows);
  }

  /** The organization's reports (any status) within a chosen distance of this one. */
  async nearby(organizationId: string, publicId: string, radius: number) {
    const report = await this.ownReport(organizationId, publicId);
    const rows = await this.prisma.$queryRaw<RelatedRow[]>`
      SELECT o.id, o.public_id, o.title, o.status, o.category_id,
             round(ST_Distance(o.location, r.location))::int AS distance_m, o.submitted_at
      FROM reports r
      JOIN reports o ON o.id <> r.id
      WHERE r.id = ${report.id}::uuid
        AND o.organization_id = ${organizationId}::uuid
        AND ST_DWithin(o.location, r.location, ${radius})
      ORDER BY ST_Distance(o.location, r.location) ASC
      LIMIT 50`;
    return this.present(rows);
  }

  /** Links the report to its original: DUPLICATE is final and always points somewhere. */
  async markDuplicate(
    organizationId: string,
    publicId: string,
    version: number,
    input: MarkDuplicateInput,
    actorId: string,
    request: Request,
  ) {
    if (input.canonicalPublicId === publicId) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'A report cannot duplicate itself.');
    }
    await this.prisma.$transaction(async (tx) => {
      const id = await lockReport(tx, publicId, { organizationId });
      const report = await tx.report.findUniqueOrThrow({
        where: { id },
        select: { id: true, status: true, version: true },
      });
      const canonical = await tx.report.findFirst({
        where: { publicId: input.canonicalPublicId, organizationId },
        select: { id: true, status: true },
      });
      if (!canonical) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Choose a report your organization handles. For another organization’s report, transfer this one instead.',
        );
      }
      if (NOT_CANONICAL.includes(canonical.status)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'That report is withdrawn, rejected or itself a duplicate, so it cannot be the original.',
        );
      }
      // No chains: a report that others point to cannot itself become a duplicate.
      const linked = await tx.report.count({ where: { duplicateOfId: report.id } });
      if (linked > 0) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Other reports are linked to this one as duplicates, so it must stay the original.',
        );
      }
      await applyTransition(tx, report, 'markDuplicate', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason: input.reason,
        data: { duplicateOfId: canonical.id },
      });
      await tx.duplicateDecision.create({
        data: {
          reportId: report.id,
          canonicalId: canonical.id,
          decision: 'CONFIRMED',
          reviewerId: actorId,
          reason: input.reason,
        },
      });
      await tx.duplicateCandidate.updateMany({
        where: {
          OR: [
            { reportId: report.id, candidateId: canonical.id },
            { reportId: canonical.id, candidateId: report.id },
          ],
        },
        data: { status: 'CONFIRMED', decidedAt: new Date() },
      });
      await this.audit.record(
        {
          action: 'report.marked_duplicate',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'report',
          targetId: report.id,
          reason: input.reason,
          metadata: { canonicalId: canonical.id, organizationId },
        },
        request,
        tx,
      );
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  /** Records that two reports are different problems; the pair stops being suggested. */
  async dismiss(
    organizationId: string,
    publicId: string,
    input: DismissDuplicateInput,
    actorId: string,
  ) {
    const report = await this.ownReport(organizationId, publicId);
    const other = await this.prisma.report.findFirst({
      where: { publicId: input.candidatePublicId, organizationId },
      select: { id: true },
    });
    if (!other) throw new AppException(ErrorCode.NOT_FOUND);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.duplicateCandidate.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { reportId: report.id, candidateId: other.id },
            { reportId: other.id, candidateId: report.id },
          ],
        },
        data: { status: 'DISMISSED', decidedAt: new Date() },
      });
      if (updated.count === 0) throw new AppException(ErrorCode.NOT_FOUND);
      await tx.duplicateDecision.create({
        data: {
          reportId: report.id,
          canonicalId: other.id,
          decision: 'DISMISSED',
          reviewerId: actorId,
          reason: input.reason ?? null,
        },
      });
    });
    return this.candidates(organizationId, publicId);
  }

  private async ownReport(organizationId: string, publicId: string) {
    const report = await this.prisma.report.findFirst({
      where: { publicId, organizationId },
      select: { id: true },
    });
    if (!report) throw new AppException(ErrorCode.NOT_FOUND);
    return report;
  }

  private async present(rows: RelatedRow[]): Promise<RelatedReport[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [categories, media] = await Promise.all([
      this.prisma.reportCategory.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.category_id))] } },
        select: { id: true, slug: true, nameEn: true, nameBn: true },
      }),
      this.prisma.reportMedia.findMany({
        where: { reportId: { in: ids } },
        orderBy: { position: 'asc' },
        select: { id: true, reportId: true },
      }),
    ]);
    const byCategory = new Map(categories.map((item) => [item.id, item]));
    return Promise.all(
      rows.map(async (row) => ({
        publicId: row.public_id,
        title: row.title,
        status: row.status,
        category: byCategory.get(row.category_id) ?? {
          id: row.category_id,
          slug: '',
          nameEn: '',
          nameBn: '',
        },
        distanceM: row.distance_m,
        submittedAt: row.submitted_at.toISOString(),
        photos: await this.views.photos(
          media.filter((item) => item.reportId === row.id).map((item) => item.id),
        ),
      })),
    );
  }
}
