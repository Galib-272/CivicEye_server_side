import { z } from 'zod';
import { PHOTO_LIMITS } from '../media/image-processing';
import { category, photo, status } from './reports.schemas';

export const ASSIGNMENT_STATES = [
  'PENDING',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'VERIFIED',
  'DECLINED',
  'RETURNED',
  'CANCELLED',
] as const;
const assignmentState = z.enum(ASSIGNMENT_STATES);

export const EVENT_KINDS = [
  'ASSIGNED',
  'ACCEPTED',
  'DECLINED',
  'STARTED',
  'PROGRESS',
  'COMPLETED',
  'APPROVED',
  'REJECTED',
  'MORE_EVIDENCE_NEEDED',
  'RETURNED',
  'CANCELLED',
] as const;

export const VERIFICATION_OUTCOMES = ['APPROVED', 'REJECTED', 'NEEDS_MORE_EVIDENCE'] as const;

/** Worker task list groups and the assignment states each one shows. */
export const TASK_GROUPS = {
  TO_ACCEPT: ['PENDING'],
  ACTIVE: ['ACCEPTED', 'IN_PROGRESS'],
  WAITING: ['COMPLETED'],
  DONE: ['VERIFIED', 'DECLINED', 'RETURNED', 'CANCELLED'],
} as const;
export type TaskGroup = keyof typeof TASK_GROUPS;
const taskGroup = z.enum(Object.keys(TASK_GROUPS) as [TaskGroup, ...TaskGroup[]]);

const reason = z.string().trim().min(10).max(1000);
const workPhotos = z.array(z.uuid()).max(PHOTO_LIMITS.maxPerReport);

// Requests: organization side.

export const assignSchema = z.strictObject({
  workerId: z.uuid(),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type AssignInput = z.infer<typeof assignSchema>;

export const reassignSchema = assignSchema.extend({ reason });
export type ReassignInput = z.infer<typeof reassignSchema>;

export const reasonSchema = z.strictObject({ reason });

export const verifySchema = z
  .strictObject({
    outcome: z.enum(VERIFICATION_OUTCOMES),
    reason: reason.optional(),
  })
  .refine((value) => value.outcome === 'APPROVED' || value.reason !== undefined, {
    message: 'Explain what is wrong or missing.',
    path: ['reason'],
  });
export type VerifyInput = z.infer<typeof verifySchema>;

// Requests: worker side.

export const tasksQuerySchema = z.strictObject({
  group: taskGroup.default('ACTIVE'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type TasksQuery = z.infer<typeof tasksQuerySchema>;

export const progressSchema = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  mediaIds: workPhotos.default([]),
});
export type ProgressInput = z.infer<typeof progressSchema>;

/** Completion evidence: a description and 1–5 after photos. */
export const completeSchema = z.strictObject({
  description: z.string().trim().min(10).max(2000),
  mediaIds: workPhotos.min(1),
});
export type CompleteInput = z.infer<typeof completeSchema>;

export const availabilitySchema = z.strictObject({ available: z.boolean() });

// Requests: citizen side.

export const feedbackSchema = z.strictObject({
  fixed: z.boolean(),
  comment: z.string().trim().min(1).max(1000).optional(),
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;

// Responses.

export const workerSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  available: z.boolean(),
  activeTasks: z.number().int(),
});

const event = z.object({
  kind: z.enum(EVENT_KINDS),
  message: z.string().nullable(),
  photos: z.array(photo),
  actorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const verification = z.object({
  outcome: z.enum(VERIFICATION_OUTCOMES),
  reason: z.string().nullable(),
  verifierName: z.string(),
  createdAt: z.iso.datetime(),
});

const submission = z.object({
  id: z.uuid(),
  description: z.string(),
  photos: z.array(photo),
  createdAt: z.iso.datetime(),
  verification: verification.nullable(),
});

/** An assignment with its full history, as the organization (and the worker) sees it. */
export const assignmentSchema = z.object({
  id: z.uuid(),
  workerId: z.uuid(),
  workerName: z.string(),
  state: assignmentState,
  note: z.string().nullable(),
  assignedAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: z.string().nullable(),
  events: z.array(event),
  submissions: z.array(submission),
});
export type AssignmentView = z.infer<typeof assignmentSchema>;

export const feedbackViewSchema = z.object({
  fixed: z.boolean(),
  comment: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const taskItemSchema = z.object({
  id: z.uuid(),
  state: assignmentState,
  organizationName: z.string(),
  publicId: z.string(),
  title: z.string(),
  category,
  reportStatus: status,
  locationDescription: z.string().nullable(),
  assignedAt: z.iso.datetime(),
});

/** The worker's view of one task: the work to do, never the reporter. */
export const taskSchema = z.object({
  assignment: assignmentSchema,
  organizationId: z.uuid(),
  organizationName: z.string(),
  report: z.object({
    publicId: z.string(),
    title: z.string(),
    description: z.string(),
    category,
    status,
    latitude: z.number(),
    longitude: z.number(),
    locationDescription: z.string().nullable(),
    photos: z.array(photo),
  }),
  actions: z.object({
    accept: z.boolean(),
    decline: z.boolean(),
    start: z.boolean(),
    progress: z.boolean(),
    returnTask: z.boolean(),
    complete: z.boolean(),
  }),
});
export type TaskView = z.infer<typeof taskSchema>;

export const workMembershipSchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  available: z.boolean(),
});
