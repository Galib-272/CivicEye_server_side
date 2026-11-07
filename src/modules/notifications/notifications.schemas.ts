import { z } from 'zod';

export const NOTIFICATION_TYPES = [
  'REPORT_UNDER_REVIEW',
  'INFORMATION_REQUESTED',
  'REPORT_ACCEPTED',
  'REPORT_REJECTED',
  'REPORT_TRANSFERRED',
  'REPORT_ASSIGNED',
  'WORK_STARTED',
  'REPORT_RESOLVED',
  'REPORT_REOPENED',
  'REPORT_CLOSED',
  'PUBLIC_UPDATE_POSTED',
  'NEW_REPORT',
  'INFORMATION_PROVIDED',
  'REPORT_WITHDRAWN',
  'TASK_DECLINED',
  'TASK_RETURNED',
  'WORK_SUBMITTED',
  'NOT_FIXED_FEEDBACK',
  'ACCEPTANCE_OVERDUE',
  'TASK_ASSIGNED',
  'TASK_CANCELLED',
  'MORE_EVIDENCE_NEEDED',
  'WORK_APPROVED',
  'REPORT_DUPLICATE',
] as const;

export const notificationsQuerySchema = z.strictObject({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

/** No report content: the app shows a translated sentence for the type and links by ID. */
export const notificationSchema = z.object({
  id: z.uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  reportPublicId: z.string().nullable(),
  organizationId: z.uuid().nullable(),
  assignmentId: z.uuid().nullable(),
  /** Where it opens in the web app. */
  path: z.string(),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const unreadCountSchema = z.object({ count: z.number().int() });

export const preferencesSchema = z.object({
  emailMyReports: z.boolean(),
  emailMyTasks: z.boolean(),
  emailOrganization: z.boolean(),
});
export const preferencesInputSchema = z.strictObject({
  emailMyReports: z.boolean(),
  emailMyTasks: z.boolean(),
  emailOrganization: z.boolean(),
});
export type PreferencesInput = z.infer<typeof preferencesInputSchema>;

export const ticketSchema = z.object({ ticket: z.string(), expiresInSeconds: z.number().int() });

export const deliveryHealthSchema = z.object({
  pendingEvents: z.number().int(),
  failedEvents: z.array(
    z.object({
      id: z.uuid(),
      type: z.string(),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  failedEmails: z.array(
    z.object({
      notificationId: z.uuid(),
      type: z.enum(NOTIFICATION_TYPES),
      failedAttempts: z.number().int(),
      lastError: z.string().nullable(),
      lastAttemptAt: z.iso.datetime(),
    }),
  ),
});
