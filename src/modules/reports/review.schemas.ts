import { z } from 'zod';
import type { ReportStatus } from '../../generated/prisma/enums';
import { category, photo, REJECTION_REASONS, ROUTING_OUTCOMES, status } from './reports.schemas';
import { assignmentSchema, feedbackViewSchema } from './work.schemas';

/** Review queue tabs and the statuses each one shows. */
export const QUEUE_TABS = {
  NEW: ['SUBMITTED'],
  UNDER_REVIEW: ['UNDER_REVIEW'],
  NEEDS_INFORMATION: ['NEEDS_INFORMATION'],
  /** Accepted or reopened: waiting for a worker. */
  ACCEPTED: ['ACCEPTED', 'REOPENED'],
  IN_WORK: ['ASSIGNED', 'IN_PROGRESS', 'WORK_COMPLETED'],
  TO_VERIFY: ['PENDING_VERIFICATION'],
  RESOLVED: ['RESOLVED', 'CLOSED'],
  CLOSED: ['REJECTED', 'WITHDRAWN'],
} as const satisfies Record<string, readonly ReportStatus[]>;
export type QueueTab = keyof typeof QUEUE_TABS;
const queueTab = z.enum(Object.keys(QUEUE_TABS) as [QueueTab, ...QueueTab[]]);

// Requests.

export const queueQuerySchema = z.strictObject({
  tab: queueTab.default('NEW'),
  categoryId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;

export const requestInformationSchema = z.strictObject({
  message: z.string().trim().min(10).max(1000),
});

export const acceptSchema = z.strictObject({
  /** Corrects the category; it must be one the organization handles. */
  categoryId: z.uuid().optional(),
  publicMessage: z.string().trim().min(1).max(1000).optional(),
});
export type AcceptInput = z.infer<typeof acceptSchema>;

export const rejectSchema = z.strictObject({
  reason: z.enum(REJECTION_REASONS),
  /** Shown to the citizen, and publicly for public reports. */
  message: z.string().trim().min(10).max(1000),
});
export type RejectInput = z.infer<typeof rejectSchema>;

export const transferSchema = z.strictObject({
  /** Null sends the report back to the Super Admin triage list. */
  toOrganizationId: z.uuid().nullable(),
  reason: z.string().trim().min(10).max(1000),
});
export type TransferInput = z.infer<typeof transferSchema>;

export const noteInputSchema = z.strictObject({ body: z.string().trim().min(1).max(2000) });
export const updateInputSchema = z.strictObject({ body: z.string().trim().min(1).max(1000) });
export const hideUpdateSchema = z.strictObject({ reason: z.string().trim().min(5).max(1000) });

// Responses.

export const queueItemSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  category,
  status,
  locationDescription: z.string().nullable(),
  photoCount: z.number().int(),
  submittedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const queueCountsSchema = z.record(queueTab, z.number().int());

const conversationEntry = z.object({
  id: z.uuid(),
  message: z.string(),
  requestedAt: z.iso.datetime(),
  response: z
    .object({ message: z.string(), photoCount: z.number().int(), respondedAt: z.iso.datetime() })
    .nullable(),
});

/**
 * The organization's workspace view: exact location and photos, but never the reporter's
 * identity — organizations talk to citizens only through information requests and updates.
 */
export const organizationReportSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  description: z.string(),
  category,
  status,
  latitude: z.number(),
  longitude: z.number(),
  locationAccuracyM: z.number().int().nullable(),
  locationDescription: z.string().nullable(),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'ORGANIZATION_ONLY', 'RESTRICTED']),
  routing: z.enum(ROUTING_OUTCOMES),
  organizationId: z.uuid().nullable(),
  organizationName: z.string().nullable(),
  version: z.number().int(),
  submittedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  photos: z.array(photo),
  informationRequests: z.array(conversationEntry),
  rejection: z.object({ reason: z.enum(REJECTION_REASONS), message: z.string() }).nullable(),
  /** Every assignment of this report, oldest first, with events, evidence and verification. */
  assignments: z.array(assignmentSchema),
  /** The reporting citizen's "Is it fixed?" answers. */
  feedback: z.array(feedbackViewSchema),
  /** What the viewer may do now; the API checks again on every action. */
  actions: z.object({
    startReview: z.boolean(),
    requestInformation: z.boolean(),
    accept: z.boolean(),
    reject: z.boolean(),
    transfer: z.boolean(),
    assign: z.boolean(),
    reassign: z.boolean(),
    cancelAssignment: z.boolean(),
    verify: z.boolean(),
    reopen: z.boolean(),
    close: z.boolean(),
    markDuplicate: z.boolean(),
  }),
});
export type OrganizationReport = z.infer<typeof organizationReportSchema>;

export const organizationHistoryEntrySchema = z.object({
  fromStatus: status.nullable(),
  toStatus: status,
  /** "citizen", "org_reviewer", "super_admin" or "system". */
  actorContext: z.string(),
  reason: z.string().nullable(),
  publicMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const internalNoteSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  authorName: z.string(),
  organizationName: z.string(),
  createdAt: z.iso.datetime(),
});

export const organizationUpdateSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  authorName: z.string(),
  organizationName: z.string(),
  createdAt: z.iso.datetime(),
  hidden: z.boolean(),
  hiddenReason: z.string().nullable(),
});

export const transferTargetSchema = z.object({ id: z.uuid(), name: z.string() });
