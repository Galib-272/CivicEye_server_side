import { z } from 'zod';

export const MODERATION_REASONS = [
  'SPAM_OR_FAKE',
  'OFFENSIVE',
  'PERSONAL_INFORMATION',
  'MISLEADING_PHOTO',
  'OTHER',
] as const;
export const CASE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
  'RESOLVED',
  'DISMISSED',
] as const;
export const OPEN_STATUSES = ['OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED'] as const;
export const ACTION_KINDS = [
  'START_REVIEW',
  'HIDE_REPORT',
  'RESTORE_REPORT',
  'HIDE_UPDATE',
  'REQUEST_CORRECTION',
  'WARN_USER',
  'SUSPEND_USER',
  'RESOLVE',
  'DISMISS',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** Actions whose message is shown to the citizen, so it must be written. */
export const NEEDS_MESSAGE: ReadonlySet<ActionKind> = new Set(['REQUEST_CORRECTION', 'WARN_USER']);

const details = z.string().trim().max(1000);

export const flagSchema = z
  .strictObject({ reason: z.enum(MODERATION_REASONS), details: details.optional() })
  .refine((input) => input.reason !== 'OTHER' || (input.details?.length ?? 0) >= 5, {
    message: 'Describe the problem (at least 5 characters) when the reason is OTHER',
    path: ['details'],
  });
export type FlagInput = z.infer<typeof flagSchema>;

export const escalateSchema = z.strictObject({
  reason: z.enum(MODERATION_REASONS),
  details: details.min(5),
});
export type EscalateInput = z.infer<typeof escalateSchema>;

export const caseQuerySchema = z.strictObject({
  /** "open" (default) lists OPEN, UNDER_REVIEW and ACTION_REQUIRED; "all" lists everything. */
  status: z.enum(['open', 'all', ...CASE_STATUSES]).default('open'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CaseQuery = z.infer<typeof caseQuerySchema>;

export const actionSchema = z
  .strictObject({
    kind: z.enum(ACTION_KINDS),
    /** Why the moderator decided this (internal, audited). */
    reason: z.string().trim().min(5).max(1000),
    /** What the citizen is told; required for REQUEST_CORRECTION and WARN_USER. */
    message: z.string().trim().min(5).max(1000).optional(),
  })
  .refine((input) => !NEEDS_MESSAGE.has(input.kind) || input.message !== undefined, {
    message: 'A message to the citizen is required for this action',
    path: ['message'],
  });
export type ActionInput = z.infer<typeof actionSchema>;

export const flagResultSchema = z.object({ received: z.literal(true) });

export const caseListItemSchema = z.object({
  id: z.uuid(),
  targetType: z.enum(['REPORT', 'PUBLIC_UPDATE']),
  status: z.enum(CASE_STATUSES),
  flagCount: z.number().int(),
  escalated: z.boolean(),
  reasons: z.array(z.enum(MODERATION_REASONS)),
  report: z.object({ publicId: z.string(), title: z.string() }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const caseDetailSchema = caseListItemSchema.extend({
  report: z.object({
    publicId: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.string(),
    visibility: z.string(),
    hiddenFromPublic: z.boolean(),
    organizationName: z.string().nullable(),
    citizen: z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.string(),
    }),
  }),
  publicUpdate: z
    .object({
      id: z.uuid(),
      body: z.string(),
      organizationName: z.string(),
      hidden: z.boolean(),
    })
    .nullable(),
  flags: z.array(
    z.object({
      reason: z.enum(MODERATION_REASONS),
      details: z.string().nullable(),
      /** "organization" for an escalation by the handling organization. */
      source: z.enum(['user', 'organization']),
      reporterName: z.string(),
      organizationName: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  actions: z.array(
    z.object({
      kind: z.enum(ACTION_KINDS),
      reason: z.string(),
      message: z.string().nullable(),
      actorName: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  /** What the moderator can do now. */
  allowedActions: z.array(z.enum(ACTION_KINDS)),
  closedAt: z.iso.datetime().nullable(),
});
export type CaseDetail = z.infer<typeof caseDetailSchema>;
