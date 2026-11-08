import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { ACCEPTANCE_REMINDER_AFTER_MS } from '../notifications/maintenance.worker';
import {
  MIN_CASES,
  RangeTooLongError,
  TREND_WEEKS,
  resolveRange,
  type Duration,
  type Range,
  type RangeQuery,
} from './analytics.schemas';

const HOUR = 3600;
const OPEN_FINAL = ['RESOLVED', 'CLOSED', 'REJECTED', 'WITHDRAWN', 'DUPLICATE'];
const BACKLOG_GROUPS = {
  awaitingReview: ['SUBMITTED', 'UNDER_REVIEW', 'REOPENED'],
  waitingForCitizen: ['NEEDS_INFORMATION'],
  accepted: ['ACCEPTED'],
  inProgress: ['ASSIGNED', 'IN_PROGRESS'],
  awaitingVerification: ['WORK_COMPLETED', 'PENDING_VERIFICATION'],
} as const;

type StatsRow = { count: number; median: number | null; p90: number | null; mean: number | null };

const round1 = (value: number | null) =>
  value === null ? null : Math.round((value / HOUR) * 10) / 10;

function toDuration(row: StatsRow | undefined): Duration {
  const count = Number(row?.count ?? 0);
  return {
    count,
    medianHours: count ? round1(Number(row?.median)) : null,
    p90Hours: count ? round1(Number(row?.p90)) : null,
    meanHours: count ? round1(Number(row?.mean)) : null,
    enoughData: count >= MIN_CASES,
  };
}

/** Median, 90th percentile and mean of a set of durations given in seconds (column `s`). */
const stats = (durations: Prisma.Sql) => Prisma.sql`
  SELECT count(*)::int AS count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY s) AS p90,
         avg(s)::float8 AS mean
  FROM (${durations}) d WHERE s >= 0`;

const counts = (rows: Array<{ key: string | null; count: number }>) =>
  Object.fromEntries(rows.map((row) => [row.key ?? 'NONE', Number(row.count)]));

/**
 * Dashboard numbers (PRD §24), each defined in docs/metrics.md. Every query is scoped by the
 * caller's own ID or organization; nothing here takes a scope from the client unchecked.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  range(query: RangeQuery, now = new Date()): Range {
    try {
      return resolveRange(query, now);
    } catch (error) {
      if (error instanceof RangeTooLongError) {
        throw new AppException(ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }
  }

  // ─── Shared durations ───────────────────────────────────────────────────────

  /** Submission to the first review decision; the first decision is by `org` (if given). */
  private reviewTimes(range: Range, organizationId: string | null) {
    return stats(Prisma.sql`
      SELECT EXTRACT(EPOCH FROM (f.first_at - r.submitted_at)) AS s
      FROM (
        SELECT DISTINCT ON (report_id) report_id, organization_id, created_at AS first_at
        FROM report_review_decisions ORDER BY report_id, created_at
      ) f JOIN reports r ON r.id = f.report_id
      WHERE f.first_at >= ${range.start} AND f.first_at < ${range.end}
        AND (${organizationId}::uuid IS NULL OR f.organization_id = ${organizationId}::uuid)`);
  }

  /** Submission to the first RESOLVED; attributed to the organization handling it now. */
  private resolutionTimes(range: Range, organizationId: string | null) {
    return stats(Prisma.sql`
      SELECT EXTRACT(EPOCH FROM (f.first_at - r.submitted_at)) AS s
      FROM (
        SELECT report_id, min(created_at) AS first_at FROM report_status_history
        WHERE to_status = 'RESOLVED' GROUP BY report_id
      ) f JOIN reports r ON r.id = f.report_id
      WHERE f.first_at >= ${range.start} AND f.first_at < ${range.end}
        AND (${organizationId}::uuid IS NULL OR r.organization_id = ${organizationId}::uuid)`);
  }

  private async duration(sql: Prisma.Sql): Promise<Duration> {
    const [row] = await this.prisma.$queryRaw<StatsRow[]>(sql);
    return toDuration(row);
  }

  private weeks(): Prisma.Sql {
    // Monday-start weeks in Bangladesh time, the current week last.
    return Prisma.sql`
      SELECT (date_trunc('week', (now() AT TIME ZONE 'Asia/Dhaka')) - make_interval(weeks => g))::date AS week_start
      FROM generate_series(0, ${TREND_WEEKS - 1}) g`;
  }

  // ─── Organization ───────────────────────────────────────────────────────────

  async organization(organizationId: string, query: RangeQuery) {
    const range = this.range(query);
    const { start, end } = range;
    const received = Prisma.sql`
      SELECT DISTINCT report_id FROM (
        SELECT report_id FROM report_routing_decisions
        WHERE organization_id = ${organizationId}::uuid AND created_at >= ${start} AND created_at < ${end}
        UNION
        SELECT report_id FROM report_transfers
        WHERE to_organization_id = ${organizationId}::uuid AND created_at >= ${start} AND created_at < ${end}
      ) x`;

    const [
      backlogRows,
      receivedCount,
      decisions,
      resolved,
      review,
      resolution,
      assignment,
      completion,
    ] = await Promise.all([
      this.prisma.$queryRaw<Array<{ key: string; count: number }>>`
          SELECT status::text AS key, count(*)::int AS count FROM reports
          WHERE organization_id = ${organizationId}::uuid GROUP BY status`,
      this.prisma.$queryRaw<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM (${received}) r`,
      this.prisma.$queryRaw<Array<{ key: string; count: number }>>`
          SELECT decision::text AS key, count(*)::int AS count FROM report_review_decisions
          WHERE organization_id = ${organizationId}::uuid AND created_at >= ${start} AND created_at < ${end}
          GROUP BY decision`,
      this.prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM (
            SELECT h.report_id, min(h.created_at) AS first_at FROM report_status_history h
            WHERE h.to_status = 'RESOLVED' GROUP BY h.report_id
          ) f JOIN reports r ON r.id = f.report_id
          WHERE r.organization_id = ${organizationId}::uuid AND f.first_at >= ${start} AND f.first_at < ${end}`,
      this.duration(this.reviewTimes(range, organizationId)),
      this.duration(this.resolutionTimes(range, organizationId)),
      this.duration(
        stats(Prisma.sql`
            SELECT EXTRACT(EPOCH FROM (a.first_assigned - acc.accepted_at)) AS s
            FROM (
              SELECT report_id, min(created_at) AS accepted_at FROM report_status_history
              WHERE to_status = 'ACCEPTED' GROUP BY report_id
            ) acc
            JOIN LATERAL (
              SELECT min(assigned_at) AS first_assigned FROM report_assignments x
              WHERE x.report_id = acc.report_id AND x.assigned_at >= acc.accepted_at
                AND x.organization_id = ${organizationId}::uuid
            ) a ON a.first_assigned IS NOT NULL
            WHERE a.first_assigned >= ${start} AND a.first_assigned < ${end}`),
      ),
      this.duration(
        stats(Prisma.sql`
            SELECT EXTRACT(EPOCH FROM (completed_at - started_at)) AS s FROM report_assignments
            WHERE organization_id = ${organizationId}::uuid AND started_at IS NOT NULL
              AND completed_at >= ${start} AND completed_at < ${end}`),
      ),
    ]);

    const [workers, categories, areas, trend] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          user_id: string;
          name: string;
          available: boolean;
          pending: number;
          active: number;
          awaiting: number;
          verified: number;
        }>
      >`
        SELECT m.user_id, u.name, m.available,
          count(*) FILTER (WHERE a.state = 'PENDING')::int AS pending,
          count(*) FILTER (WHERE a.state IN ('ACCEPTED', 'IN_PROGRESS'))::int AS active,
          count(*) FILTER (WHERE a.state = 'COMPLETED')::int AS awaiting,
          count(*) FILTER (WHERE a.state = 'VERIFIED' AND a.ended_at >= ${start} AND a.ended_at < ${end})::int AS verified
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN report_assignments a ON a.worker_id = m.user_id AND a.organization_id = m.organization_id
        WHERE m.organization_id = ${organizationId}::uuid AND m.role = 'WORKER' AND m.status = 'ACTIVE'
        GROUP BY m.user_id, u.name, m.available
        ORDER BY u.name`,
      this.prisma.$queryRaw<Array<{ id: string; name_en: string; name_bn: string; count: number }>>`
        SELECT c.id, c.name_en, c.name_bn, count(*)::int AS count
        FROM (${received}) x JOIN reports r ON r.id = x.report_id
        JOIN report_categories c ON c.id = r.category_id
        GROUP BY c.id, c.name_en, c.name_bn ORDER BY count DESC, c.name_en`,
      this.prisma.$queryRaw<Array<{ id: string | null; name: string; count: number }>>`
        WITH rec AS (SELECT r.id, r.location FROM (${received}) x JOIN reports r ON r.id = x.report_id),
        inside AS (
          SELECT a.id, a.name, rec.id AS report_id FROM rec
          JOIN service_areas a ON a.organization_id = ${organizationId}::uuid
            AND ST_Covers(a.geom, rec.location::geometry)
        )
        SELECT id, name, count(*)::int AS count FROM inside GROUP BY id, name
        UNION ALL
        SELECT NULL, 'outside', count(*)::int FROM rec
        WHERE rec.id NOT IN (SELECT report_id FROM inside)
        ORDER BY count DESC`,
      this.prisma.$queryRaw<Array<{ week_start: Date; received: number; resolved: number }>>`
        WITH weeks AS (${this.weeks()}),
        rec AS (
          SELECT created_at FROM report_routing_decisions WHERE organization_id = ${organizationId}::uuid
          UNION ALL
          SELECT created_at FROM report_transfers WHERE to_organization_id = ${organizationId}::uuid
        ),
        res AS (
          SELECT min(h.created_at) AS at FROM report_status_history h JOIN reports r ON r.id = h.report_id
          WHERE h.to_status = 'RESOLVED' AND r.organization_id = ${organizationId}::uuid GROUP BY h.report_id
        )
        SELECT w.week_start,
          (SELECT count(*) FROM rec WHERE (rec.created_at AT TIME ZONE 'Asia/Dhaka')::date >= w.week_start
             AND (rec.created_at AT TIME ZONE 'Asia/Dhaka')::date < w.week_start + 7)::int AS received,
          (SELECT count(*) FROM res WHERE (res.at AT TIME ZONE 'Asia/Dhaka')::date >= w.week_start
             AND (res.at AT TIME ZONE 'Asia/Dhaka')::date < w.week_start + 7)::int AS resolved
        FROM weeks w ORDER BY w.week_start`,
    ]);

    const byStatus = counts(backlogRows);
    const group = (statuses: readonly string[]) =>
      statuses.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0);
    const decided = counts(decisions);
    return {
      range: { from: range.from, to: range.to },
      backlog: {
        awaitingReview: group(BACKLOG_GROUPS.awaitingReview),
        waitingForCitizen: group(BACKLOG_GROUPS.waitingForCitizen),
        accepted: group(BACKLOG_GROUPS.accepted),
        inProgress: group(BACKLOG_GROUPS.inProgress),
        awaitingVerification: group(BACKLOG_GROUPS.awaitingVerification),
        byStatus,
      },
      volume: {
        received: Number(receivedCount[0]?.count ?? 0),
        accepted: decided.ACCEPTED ?? 0,
        rejected: decided.REJECTED ?? 0,
        resolved: Number(resolved[0]?.count ?? 0),
      },
      times: { review, resolution, assignment, completion },
      workers: workers.map((row) => ({
        userId: row.user_id,
        name: row.name,
        available: row.available,
        pending: row.pending,
        active: row.active,
        awaitingVerification: row.awaiting,
        verifiedInRange: row.verified,
      })),
      categories: categories.map((row) => ({
        id: row.id,
        nameEn: row.name_en,
        nameBn: row.name_bn,
        count: row.count,
      })),
      areas: areas.filter((row) => row.count > 0),
      trend: trend.map((row) => ({
        weekStart: row.week_start.toISOString().slice(0, 10),
        received: row.received,
        resolved: row.resolved,
      })),
    };
  }

  // ─── Worker ─────────────────────────────────────────────────────────────────

  async worker(workerId: string, now = new Date()) {
    const overdueBefore = new Date(now.getTime() - ACCEPTANCE_REMINDER_AFTER_MS);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
    const [states, completed30, overdue, completion, recent] = await Promise.all([
      this.prisma.reportAssignment.groupBy({
        by: ['state'],
        where: { workerId },
        _count: { _all: true },
      }),
      this.prisma.reportAssignment.count({
        where: { workerId, state: 'VERIFIED', endedAt: { gte: monthAgo } },
      }),
      this.prisma.reportAssignment.count({
        where: { workerId, state: 'PENDING', assignedAt: { lt: overdueBefore } },
      }),
      this.duration(
        stats(Prisma.sql`
          SELECT EXTRACT(EPOCH FROM (completed_at - started_at)) AS s FROM report_assignments
          WHERE worker_id = ${workerId}::uuid AND started_at IS NOT NULL AND completed_at IS NOT NULL`),
      ),
      this.prisma.reportAssignment.findMany({
        where: { workerId },
        orderBy: { assignedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          state: true,
          assignedAt: true,
          completedAt: true,
          endedAt: true,
          report: { select: { publicId: true, title: true } },
          organization: { select: { name: true } },
        },
      }),
    ]);
    const count = (...wanted: string[]) =>
      states
        .filter((row) => wanted.includes(row.state))
        .reduce((sum, row) => sum + row._count._all, 0);
    return {
      pending: count('PENDING'),
      active: count('ACCEPTED', 'IN_PROGRESS'),
      awaitingVerification: count('COMPLETED'),
      completedTotal: count('VERIFIED'),
      completedLast30Days: completed30,
      overdue,
      completion,
      recent: recent.map((row) => ({
        assignmentId: row.id,
        reportPublicId: row.report.publicId,
        reportTitle: row.report.title,
        organizationName: row.organization.name,
        state: row.state,
        assignedAt: row.assignedAt.toISOString(),
        finishedAt: (row.endedAt ?? row.completedAt)?.toISOString() ?? null,
      })),
    };
  }

  // ─── Citizen ────────────────────────────────────────────────────────────────

  async citizen(citizenId: string) {
    const [groups, unread, recent] = await Promise.all([
      this.prisma.report.groupBy({ by: ['status'], where: { citizenId }, _count: { _all: true } }),
      this.prisma.notification.count({ where: { recipientId: citizenId, readAt: null } }),
      this.prisma.reportStatusHistory.findMany({
        where: { report: { citizenId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          toStatus: true,
          createdAt: true,
          report: { select: { publicId: true, title: true } },
        },
      }),
    ]);
    const byStatus = Object.fromEntries(groups.map((row) => [row.status, row._count._all]));
    const total = groups.reduce((sum, row) => sum + row._count._all, 0);
    return {
      total,
      open: groups
        .filter((row) => !OPEN_FINAL.includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0),
      resolved: (byStatus.RESOLVED ?? 0) + (byStatus.CLOSED ?? 0),
      byStatus,
      unreadNotifications: unread,
      recentActivity: recent.map((row) => ({
        reportPublicId: row.report.publicId,
        reportTitle: row.report.title,
        status: row.toStatus,
        at: row.createdAt.toISOString(),
      })),
    };
  }

  // ─── Platform (Super Admin) ─────────────────────────────────────────────────

  async platform(query: RangeQuery) {
    const range = this.range(query);
    const { start, end } = range;
    const [
      userStatus,
      newUsers,
      organizations,
      reportStatus,
      submitted,
      triage,
      byCategory,
      performance,
      geography,
      activity,
      moderation,
      flags,
    ] = await Promise.all([
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: start, lt: end } } }),
      this.prisma.$queryRaw<Array<{ total: number; active: number; verified: number }>>`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE is_active)::int AS active,
               count(*) FILTER (WHERE verification_state = 'VERIFIED')::int AS verified
        FROM organizations`,
      this.prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.report.count({ where: { submittedAt: { gte: start, lt: end } } }),
      this.prisma.report.count({
        where: {
          status: 'SUBMITTED',
          organizationId: null,
          routingOutcome: { in: ['UNROUTED', 'AMBIGUOUS'] },
        },
      }),
      this.prisma.$queryRaw<Array<{ id: string; name_en: string; name_bn: string; count: number }>>`
        SELECT c.id, c.name_en, c.name_bn, count(*)::int AS count FROM reports r
        JOIN report_categories c ON c.id = r.category_id
        WHERE r.submitted_at >= ${start} AND r.submitted_at < ${end}
        GROUP BY c.id, c.name_en, c.name_bn ORDER BY count DESC, c.name_en`,
      this.prisma.$queryRaw<
        Array<{
          id: string;
          name: string;
          received: number;
          resolved: number;
          backlog: number;
          count: number;
          median: number | null;
          p90: number | null;
          mean: number | null;
        }>
      >`
        WITH first_resolved AS (
          SELECT report_id, min(created_at) AS at FROM report_status_history
          WHERE to_status = 'RESOLVED' GROUP BY report_id
        ),
        rec AS (
          SELECT organization_id, report_id FROM report_routing_decisions
          WHERE organization_id IS NOT NULL AND created_at >= ${start} AND created_at < ${end}
          UNION
          SELECT to_organization_id, report_id FROM report_transfers
          WHERE to_organization_id IS NOT NULL AND created_at >= ${start} AND created_at < ${end}
        ),
        res AS (
          SELECT r.organization_id, EXTRACT(EPOCH FROM (f.at - r.submitted_at)) AS s
          FROM first_resolved f JOIN reports r ON r.id = f.report_id
          WHERE f.at >= ${start} AND f.at < ${end} AND r.organization_id IS NOT NULL
        )
        SELECT o.id, o.name,
          (SELECT count(*) FROM rec WHERE rec.organization_id = o.id)::int AS received,
          (SELECT count(*) FROM res WHERE res.organization_id = o.id)::int AS resolved,
          (SELECT count(*) FROM reports r WHERE r.organization_id = o.id
             AND r.status NOT IN ('RESOLVED', 'CLOSED', 'REJECTED', 'WITHDRAWN', 'DUPLICATE'))::int AS backlog,
          (SELECT count(*) FROM res WHERE res.organization_id = o.id AND s >= 0)::int AS count,
          (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) FROM res WHERE res.organization_id = o.id AND s >= 0) AS median,
          (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY s) FROM res WHERE res.organization_id = o.id AND s >= 0) AS p90,
          (SELECT avg(s)::float8 FROM res WHERE res.organization_id = o.id AND s >= 0) AS mean
        FROM organizations o WHERE o.verification_state = 'VERIFIED'
        ORDER BY received DESC, o.name`,
      this.prisma.$queryRaw<Array<{ id: string | null; name: string | null; count: number }>>`
        SELECT o.id, o.name, count(*)::int AS count FROM reports r
        LEFT JOIN organizations o ON o.id = r.organization_id
        WHERE r.submitted_at >= ${start} AND r.submitted_at < ${end}
        GROUP BY o.id, o.name ORDER BY count DESC`,
      this.prisma.$queryRaw<
        Array<{ week_start: Date; submitted: number; resolved: number; new_users: number }>
      >`
        WITH weeks AS (${this.weeks()}),
        res AS (
          SELECT min(created_at) AS at FROM report_status_history
          WHERE to_status = 'RESOLVED' GROUP BY report_id
        )
        SELECT w.week_start,
          (SELECT count(*) FROM reports r WHERE (r.submitted_at AT TIME ZONE 'Asia/Dhaka')::date >= w.week_start
             AND (r.submitted_at AT TIME ZONE 'Asia/Dhaka')::date < w.week_start + 7)::int AS submitted,
          (SELECT count(*) FROM res WHERE (res.at AT TIME ZONE 'Asia/Dhaka')::date >= w.week_start
             AND (res.at AT TIME ZONE 'Asia/Dhaka')::date < w.week_start + 7)::int AS resolved,
          (SELECT count(*) FROM users u WHERE (u.created_at AT TIME ZONE 'Asia/Dhaka')::date >= w.week_start
             AND (u.created_at AT TIME ZONE 'Asia/Dhaka')::date < w.week_start + 7)::int AS new_users
        FROM weeks w ORDER BY w.week_start`,
      this.prisma.moderationCase.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.moderationFlag.count({ where: { createdAt: { gte: start, lt: end } } }),
    ]);

    const statusCounts = (rows: Array<{ status: string; _count: { _all: number } }>) =>
      Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
    return {
      range: { from: range.from, to: range.to },
      users: {
        total: userStatus.reduce((sum, row) => sum + row._count._all, 0),
        byStatus: statusCounts(userStatus),
        newInRange: newUsers,
      },
      organizations: {
        total: organizations[0]?.total ?? 0,
        active: organizations[0]?.active ?? 0,
        verified: organizations[0]?.verified ?? 0,
      },
      reports: {
        total: reportStatus.reduce((sum, row) => sum + row._count._all, 0),
        submittedInRange: submitted,
        inTriage: triage,
        byStatus: statusCounts(reportStatus),
        byCategory: byCategory.map((row) => ({
          id: row.id,
          nameEn: row.name_en,
          nameBn: row.name_bn,
          count: row.count,
        })),
      },
      organizationPerformance: performance.map((row) => ({
        organizationId: row.id,
        name: row.name,
        received: row.received,
        resolved: row.resolved,
        backlog: row.backlog,
        resolution: toDuration(row),
      })),
      geography: geography.map((row) => ({
        id: row.id,
        name: row.name ?? 'none',
        count: row.count,
      })),
      activity: activity.map((row) => ({
        weekStart: row.week_start.toISOString().slice(0, 10),
        submitted: row.submitted,
        resolved: row.resolved,
        newUsers: row.new_users,
      })),
      moderation: { byStatus: statusCounts(moderation), flagsInRange: flags },
    };
  }
}
