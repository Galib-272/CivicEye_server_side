import { z } from 'zod';

/** Dashboards count days in Bangladesh time (UTC+06:00, no daylight saving). See docs/metrics.md. */
export const DHAKA_OFFSET = '+06:00';
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;
/** Below this many cases a duration is shown as "too few cases to judge" (PRD §24.5). */
export const MIN_CASES = 5;
export const TREND_WEEKS = 12;

const day = z.iso.date();

export const rangeQuerySchema = z
  .strictObject({ from: day.optional(), to: day.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must be on or before to',
    path: ['from'],
  });
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export interface Range {
  from: string;
  to: string;
  /** Inclusive start instant. */
  start: Date;
  /** Exclusive end instant (the day after `to`, 00:00 Bangladesh time). */
  end: Date;
}

const DAY_MS = 86_400_000;

/** Today's date in Bangladesh, as YYYY-MM-DD. */
export function dhakaToday(now = new Date()): string {
  return new Date(now.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Resolves a requested range; the default is the last 30 days, today included. */
export function resolveRange(query: RangeQuery, now = new Date()): Range {
  const to = query.to ?? dhakaToday(now);
  const from =
    query.from ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
  const start = new Date(`${from}T00:00:00${DHAKA_OFFSET}`);
  const end = new Date(new Date(`${to}T00:00:00${DHAKA_OFFSET}`).getTime() + DAY_MS);
  if ((end.getTime() - start.getTime()) / DAY_MS > MAX_RANGE_DAYS) {
    throw new RangeTooLongError();
  }
  return { from, to, start, end };
}

export class RangeTooLongError extends Error {
  constructor() {
    super(`The date range can be at most ${MAX_RANGE_DAYS} days.`);
  }
}

export const durationSchema = z.object({
  count: z.number().int(),
  medianHours: z.number().nullable(),
  p90Hours: z.number().nullable(),
  meanHours: z.number().nullable(),
  /** False when there are fewer than 5 cases: do not judge performance from it. */
  enoughData: z.boolean(),
});
export type Duration = z.infer<typeof durationSchema>;

const rangeSchema = z.object({ from: z.iso.date(), to: z.iso.date() });
const countItem = z.object({
  id: z.string().nullable(),
  name: z.string(),
  count: z.number().int(),
});
const category = z.object({
  id: z.uuid(),
  nameEn: z.string(),
  nameBn: z.string(),
  count: z.number().int(),
});
const week = z.object({ weekStart: z.iso.date() });

export const organizationAnalyticsSchema = z.object({
  range: rangeSchema,
  backlog: z.object({
    awaitingReview: z.number().int(),
    waitingForCitizen: z.number().int(),
    accepted: z.number().int(),
    inProgress: z.number().int(),
    awaitingVerification: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
  }),
  volume: z.object({
    received: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    resolved: z.number().int(),
  }),
  times: z.object({
    review: durationSchema,
    resolution: durationSchema,
    assignment: durationSchema,
    completion: durationSchema,
  }),
  workers: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      available: z.boolean(),
      pending: z.number().int(),
      active: z.number().int(),
      awaitingVerification: z.number().int(),
      verifiedInRange: z.number().int(),
    }),
  ),
  categories: z.array(category),
  areas: z.array(countItem),
  trend: z.array(week.extend({ received: z.number().int(), resolved: z.number().int() })),
});

export const workerAnalyticsSchema = z.object({
  pending: z.number().int(),
  active: z.number().int(),
  awaitingVerification: z.number().int(),
  completedTotal: z.number().int(),
  completedLast30Days: z.number().int(),
  overdue: z.number().int(),
  completion: durationSchema,
  recent: z.array(
    z.object({
      assignmentId: z.uuid(),
      reportPublicId: z.string(),
      reportTitle: z.string(),
      organizationName: z.string(),
      state: z.string(),
      assignedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
    }),
  ),
});

export const citizenAnalyticsSchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  resolved: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  unreadNotifications: z.number().int(),
  recentActivity: z.array(
    z.object({
      reportPublicId: z.string(),
      reportTitle: z.string(),
      status: z.string(),
      at: z.iso.datetime(),
    }),
  ),
});

export const platformAnalyticsSchema = z.object({
  range: rangeSchema,
  users: z.object({
    total: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    newInRange: z.number().int(),
  }),
  organizations: z.object({
    total: z.number().int(),
    active: z.number().int(),
    verified: z.number().int(),
  }),
  reports: z.object({
    total: z.number().int(),
    submittedInRange: z.number().int(),
    inTriage: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    byCategory: z.array(category),
  }),
  organizationPerformance: z.array(
    z.object({
      organizationId: z.uuid(),
      name: z.string(),
      received: z.number().int(),
      resolved: z.number().int(),
      backlog: z.number().int(),
      resolution: durationSchema,
    }),
  ),
  geography: z.array(countItem),
  activity: z.array(
    week.extend({
      submitted: z.number().int(),
      resolved: z.number().int(),
      newUsers: z.number().int(),
    }),
  ),
  moderation: z.object({
    byStatus: z.record(z.string(), z.number().int()),
    flagsInRange: z.number().int(),
  }),
});
