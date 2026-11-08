import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AiServiceError, analyzePhoto, serviceVersion, type AiLabel } from './ai-client';
import { SUGGESTED_CATEGORY_SLUGS, type AiPredictionView, type AiReviewInput } from './ai.schemas';

export const AI_QUEUE = Symbol('AI_QUEUE');
export const AI_QUEUE_NAME = 'ai-inference';
/** Attempts per photo before the analysis is marked FAILED (BullMQ retries with backoff). */
export const AI_JOB_ATTEMPTS = 4;
/** Pending analyses older than this are queued again (a lost queue write, a restart). */
const STALE_AFTER_MS = 2 * 60 * 1000;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;

type Scope = { organizationId: string } | { admin: true };

/**
 * Advisory AI (PRD §16-17): every submitted report photo is analysed in the background, and
 * reviewers see the result as a suggestion. The AI never changes a report, and when it fails or
 * is switched off, reports work exactly as before.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_QUEUE) private readonly queue: Queue,
  ) {}

  get enabled(): boolean {
    return this.config.ai.enabled;
  }

  // ─── Queueing ───────────────────────────────────────────────────────────────

  /** Inside the submission transaction: one pending analysis per photo, if the AI is on. */
  async recordPending(
    tx: Prisma.TransactionClient,
    reportId: string,
    mediaIds: string[],
  ): Promise<string[]> {
    if (!this.enabled || mediaIds.length === 0) return [];
    const rows = await tx.aiPrediction.createManyAndReturn({
      data: mediaIds.map((mediaId) => ({ reportId, mediaId })),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** After commit. A failure here is logged only: the stale sweep queues the photo later. */
  async enqueue(predictionIds: string[]): Promise<void> {
    for (const id of predictionIds) {
      await this.queue
        .add(
          'analyze',
          { predictionId: id },
          {
            jobId: id,
            attempts: AI_JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: 5_000 },
          },
        )
        .catch((error: unknown) =>
          this.logger.error({ err: error, predictionId: id }, 'Could not queue AI analysis'),
        );
    }
  }

  /** Queues pending analyses that were never picked up. Returns how many. */
  async requeueStale(now = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    const stale = await this.prisma.aiPrediction.findMany({
      where: {
        status: 'PENDING',
        createdAt: {
          lt: new Date(now.getTime() - STALE_AFTER_MS),
          gt: new Date(now.getTime() - DAY_MS),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true },
    });
    // Same job ID: BullMQ ignores the add while that job is still waiting or running.
    await this.enqueue(stale.map((row) => row.id));
    return stale.length;
  }

  // ─── Processing (worker) ────────────────────────────────────────────────────

  /**
   * Analyses one photo. Throws on errors worth retrying (the queue retries); records permanent
   * failures at once.
   */
  async process(predictionId: string): Promise<void> {
    const prediction = await this.prisma.aiPrediction.findUnique({
      where: { id: predictionId },
      select: { status: true, media: { select: { displayKey: true } } },
    });
    if (!prediction || prediction.status !== 'PENDING') return;
    if (!this.enabled) return this.markFailed(predictionId, 'ai_disabled');
    if (!prediction.media.displayKey) return this.markFailed(predictionId, 'photo_missing');

    await this.prisma.aiPrediction.update({
      where: { id: predictionId },
      data: { attempts: { increment: 1 } },
    });
    const photo = await this.storage.read(prediction.media.displayKey, MAX_PHOTO_BYTES);
    const started = Date.now();
    let analysis;
    try {
      analysis = await analyzePhoto(this.config.ai, photo);
    } catch (error) {
      if (error instanceof AiServiceError && error.permanent) {
        this.logger.warn({ predictionId, code: error.code }, 'AI analysis failed permanently');
        return this.markFailed(predictionId, error.code);
      }
      throw error;
    }
    await this.prisma.aiPrediction.updateMany({
      where: { id: predictionId, status: 'PENDING' },
      data: {
        status: 'SUCCEEDED',
        modelVersion: analysis.modelVersion,
        label: analysis.label,
        confidence: analysis.confidence,
        uncertain: analysis.uncertain,
        output: {
          probabilities: analysis.probabilities,
          damageProbability: analysis.damageProbability,
          detections: analysis.detections,
          quality: analysis.quality,
          timingsMs: analysis.timingsMs,
        },
        latencyMs: Date.now() - started,
        completedAt: new Date(),
        errorCode: null,
      },
    });
  }

  /** Records a failed analysis. The report itself is never affected. */
  async markFailed(predictionId: string, code: string): Promise<void> {
    await this.prisma.aiPrediction.updateMany({
      where: { id: predictionId, status: 'PENDING' },
      data: { status: 'FAILED', errorCode: code.slice(0, 60), completedAt: new Date() },
    });
  }

  // ─── Views and review ───────────────────────────────────────────────────────

  /** The latest analysis of each photo of a report the caller may review. */
  async forReport(scope: Scope, publicId: string) {
    const report = await this.reportInScope(scope, publicId);
    const rows = await this.prisma.aiPrediction.findMany({
      where: { reportId: report.id },
      orderBy: { createdAt: 'desc' },
      include: { media: { select: { position: true } } },
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.mediaId)) latest.set(row.mediaId, row);
    const ordered = [...latest.values()].sort((a, b) => a.media.position - b.media.position);
    const categories = await this.suggestionCategories();
    return {
      enabled: this.enabled,
      predictions: ordered.map((row) => this.present(row, categories)),
    };
  }

  /** A reviewer accepts, corrects or dismisses a suggestion. Recorded once, and audited. */
  async review(
    scope: Scope,
    publicId: string,
    predictionId: string,
    input: AiReviewInput,
    reviewerId: string,
    request: Request,
  ) {
    const report = await this.reportInScope(scope, publicId);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.aiPrediction.updateMany({
        where: { id: predictionId, reportId: report.id, status: 'SUCCEEDED', reviewAction: null },
        data: {
          reviewAction: input.action,
          correctedLabel: input.correctedLabel ?? null,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const exists = await tx.aiPrediction.findFirst({
          where: { id: predictionId, reportId: report.id },
          select: { status: true },
        });
        if (!exists) throw new AppException(ErrorCode.NOT_FOUND);
        throw new AppException(
          ErrorCode.CONFLICT,
          exists.status === 'SUCCEEDED'
            ? 'This suggestion has already been reviewed.'
            : 'Only a finished analysis can be reviewed.',
        );
      }
      await this.audit.record(
        {
          action: 'ai.prediction_reviewed',
          result: 'SUCCESS',
          actorUserId: reviewerId,
          targetType: 'ai_prediction',
          targetId: predictionId,
          metadata: {
            reportId: report.id,
            action: input.action,
            correctedLabel: input.correctedLabel ?? null,
          },
        },
        request,
        tx,
      );
    });
    return this.forReport(scope, publicId);
  }

  /** Monitoring for Super Admins (PRD §19.5): service state, failures and corrections. */
  async status(now = new Date()) {
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const [byStatus, byAction, latency, version] = await Promise.all([
      this.prisma.aiPrediction.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.aiPrediction.groupBy({
        by: ['reviewAction'],
        where: { createdAt: { gte: since }, reviewAction: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ median: number | null }>>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS median
        FROM ai_predictions WHERE status = 'SUCCEEDED' AND created_at >= ${since}`,
      this.enabled ? serviceVersion(this.config.ai) : Promise.resolve(null),
    ]);
    const count = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    const actions = (action: string) =>
      byAction.find((row) => row.reviewAction === action)?._count._all ?? 0;
    const reviewed = actions('ACCEPTED') + actions('CORRECTED') + actions('DISMISSED');
    const median = latency[0]?.median;
    return {
      enabled: this.enabled,
      serviceModelVersion: version,
      last7Days: {
        pending: count('PENDING'),
        succeeded: count('SUCCEEDED'),
        failed: count('FAILED'),
        reviewed,
        accepted: actions('ACCEPTED'),
        corrected: actions('CORRECTED'),
        dismissed: actions('DISMISSED'),
        correctionRate: reviewed > 0 ? actions('CORRECTED') / reviewed : null,
        medianLatencyMs:
          median === null || median === undefined ? null : Math.round(Number(median)),
      },
    };
  }

  private async reportInScope(scope: Scope, publicId: string) {
    const report = await this.prisma.report.findFirst({
      where:
        'organizationId' in scope
          ? { publicId, organizationId: scope.organizationId }
          : { publicId },
      select: { id: true },
    });
    if (!report) throw new AppException(ErrorCode.NOT_FOUND);
    return report;
  }

  private async suggestionCategories() {
    const slugs = Object.values(SUGGESTED_CATEGORY_SLUGS).flat();
    const rows = await this.prisma.reportCategory.findMany({
      where: { slug: { in: slugs }, isActive: true },
      select: { id: true, slug: true, nameEn: true, nameBn: true },
    });
    return new Map(rows.map((row) => [row.slug, row]));
  }

  private present(
    row: Prisma.AiPredictionGetPayload<{ include: { media: { select: { position: true } } } }>,
    categories: Map<string, { id: string; slug: string; nameEn: string; nameBn: string }>,
  ): AiPredictionView {
    const output = (row.output ?? {}) as {
      probabilities?: Record<string, number>;
      detections?: Array<{ box: number[]; score: number }>;
      quality?: { warnings?: string[] };
    };
    const label = row.label as AiLabel | null;
    return {
      id: row.id,
      mediaId: row.mediaId,
      photoPosition: row.media.position,
      status: row.status,
      modelVersion: row.modelVersion,
      label,
      confidence: row.confidence,
      uncertain: row.uncertain,
      probabilities: output.probabilities ?? null,
      detections: output.detections ?? [],
      warnings: output.quality?.warnings ?? [],
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      suggestedCategories: label
        ? SUGGESTED_CATEGORY_SLUGS[label].flatMap((slug) => {
            const category = categories.get(slug);
            return category ? [category] : [];
          })
        : [],
      review: row.reviewAction
        ? {
            action: row.reviewAction,
            correctedLabel: row.correctedLabel as AiLabel | null,
            reviewedAt: (row.reviewedAt ?? row.createdAt).toISOString(),
          }
        : null,
    };
  }
}
