import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { MediaService } from '../media/media.service';
import type { photo } from './reports.schemas';
import type { AssignmentView } from './work.schemas';

const ASSIGNMENT_SELECT = {
  id: true,
  workerId: true,
  state: true,
  note: true,
  assignedAt: true,
  acceptedAt: true,
  startedAt: true,
  completedAt: true,
  endedAt: true,
  endReason: true,
  worker: { select: { name: true } },
  events: {
    orderBy: { createdAt: 'asc' },
    select: {
      kind: true,
      message: true,
      mediaIds: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  },
  submissions: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      description: true,
      mediaIds: true,
      createdAt: true,
      verification: {
        select: {
          outcome: true,
          reason: true,
          createdAt: true,
          verifier: { select: { name: true } },
        },
      },
    },
  },
} as const satisfies Prisma.ReportAssignmentSelect;

type AssignmentRow = Prisma.ReportAssignmentGetPayload<{ select: typeof ASSIGNMENT_SELECT }>;
type Photo = z.infer<typeof photo>;

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Builds assignment histories (with short-lived photo URLs) for organization and worker views. */
@Injectable()
export class AssignmentViews {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  async forReport(reportId: string): Promise<AssignmentView[]> {
    const rows = await this.prisma.reportAssignment.findMany({
      where: { reportId },
      orderBy: { assignedAt: 'asc' },
      select: ASSIGNMENT_SELECT,
    });
    return Promise.all(rows.map((row) => this.build(row)));
  }

  async one(assignmentId: string): Promise<AssignmentView> {
    const row = await this.prisma.reportAssignment.findUniqueOrThrow({
      where: { id: assignmentId },
      select: ASSIGNMENT_SELECT,
    });
    return this.build(row);
  }

  /** Signed URLs for processed photos, in the given order. */
  async photos(mediaIds: readonly string[]): Promise<Photo[]> {
    if (mediaIds.length === 0) return [];
    const media = await this.prisma.reportMedia.findMany({
      where: { id: { in: [...mediaIds] } },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        displayKey: true,
        thumbnailKey: true,
      },
    });
    const byId = new Map(media.map((item) => [item.id, item]));
    const views = await Promise.all(
      mediaIds
        .map((id) => byId.get(id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
        .map((item) => this.media.toView(item)),
    );
    return views.map(({ id, thumbnailUrl, displayUrl }) => ({ id, thumbnailUrl, displayUrl }));
  }

  private async build(row: AssignmentRow): Promise<AssignmentView> {
    return {
      id: row.id,
      workerId: row.workerId,
      workerName: row.worker.name,
      state: row.state,
      note: row.note,
      assignedAt: row.assignedAt.toISOString(),
      acceptedAt: iso(row.acceptedAt),
      startedAt: iso(row.startedAt),
      completedAt: iso(row.completedAt),
      endedAt: iso(row.endedAt),
      endReason: row.endReason,
      events: await Promise.all(
        row.events.map(async (event) => ({
          kind: event.kind,
          message: event.message,
          photos: await this.photos(event.mediaIds),
          actorName: event.actor?.name ?? null,
          createdAt: event.createdAt.toISOString(),
        })),
      ),
      submissions: await Promise.all(
        row.submissions.map(async (submission) => ({
          id: submission.id,
          description: submission.description,
          photos: await this.photos(submission.mediaIds),
          createdAt: submission.createdAt.toISOString(),
          verification: submission.verification
            ? {
                outcome: submission.verification.outcome,
                reason: submission.verification.reason,
                verifierName: submission.verification.verifier.name,
                createdAt: submission.verification.createdAt.toISOString(),
              }
            : null,
        })),
      ),
    };
  }
}
