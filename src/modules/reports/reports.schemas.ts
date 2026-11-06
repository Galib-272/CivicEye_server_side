import { z } from 'zod';
import { PHOTO_LIMITS } from '../media/image-processing';

/**
 * Plausible bounds for Bangladesh (launch country), with a small margin. Rejects swapped or
 * placeholder coordinates such as (0, 0). Widen when other countries are approved.
 */
export const SERVICE_BOUNDS = { minLat: 20.3, maxLat: 26.8, minLng: 88.0, maxLng: 92.8 } as const;

const latitude = z.number().min(SERVICE_BOUNDS.minLat).max(SERVICE_BOUNDS.maxLat);
const longitude = z.number().min(SERVICE_BOUNDS.minLng).max(SERVICE_BOUNDS.maxLng);

export const REPORT_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'NEEDS_INFORMATION',
  'ACCEPTED',
  'REJECTED',
  'ASSIGNED',
  'IN_PROGRESS',
  'WORK_COMPLETED',
  'PENDING_VERIFICATION',
  'RESOLVED',
  'REOPENED',
  'CLOSED',
  'WITHDRAWN',
  'DUPLICATE',
] as const;
export const status = z.enum(REPORT_STATUSES);

// Requests.

const reportFields = {
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(10).max(2000),
  categoryId: z.uuid(),
  latitude,
  longitude,
  locationAccuracyM: z.number().int().min(0).max(100_000).nullable().optional(),
  locationDescription: z.string().trim().max(300).nullable().optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
};

export const createReportSchema = z.strictObject({
  ...reportFields,
  mediaIds: z.array(z.uuid()).min(1).max(PHOTO_LIMITS.maxPerReport),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

/** Citizens may change these fields while the report is still SUBMITTED. Photos are fixed. */
export const updateReportSchema = z
  .strictObject({
    title: reportFields.title.optional(),
    description: reportFields.description.optional(),
    categoryId: reportFields.categoryId.optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    locationAccuracyM: reportFields.locationAccuracyM,
    locationDescription: reportFields.locationDescription,
    visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.')
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: 'Latitude and longitude must be changed together.',
    path: ['longitude'],
  });
export type UpdateReportInput = z.infer<typeof updateReportSchema>;

/** The citizen's answer to an information request, with up to 5 photos in total. */
export const provideInformationSchema = z.strictObject({
  message: z.string().trim().min(10).max(2000),
  mediaIds: z.array(z.uuid()).max(PHOTO_LIMITS.maxPerReport).default([]),
});
export type ProvideInformationInput = z.infer<typeof provideInformationSchema>;

export const REJECTION_REASONS = [
  'NOT_A_CIVIC_ISSUE',
  'INSUFFICIENT_INFORMATION',
  'ALREADY_FIXED',
  'INAPPROPRIATE_CONTENT',
  'NO_RESPONSE',
  'OTHER',
] as const;

export const ROUTING_OUTCOMES = [
  'ROUTED',
  'UNROUTED',
  'AMBIGUOUS',
  'MANUAL',
  'TRANSFERRED',
] as const;

export const withdrawSchema = z.strictObject({ reason: z.string().trim().min(5).max(1000) });

export const routeReportSchema = z.strictObject({
  organizationId: z.uuid(),
  reason: z.string().trim().min(5).max(1000),
});

export const publicIdSchema = z.string().regex(/^CE-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

export const myReportsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: status.optional(),
});

export const publicReportsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  categoryId: z.uuid().optional(),
  status: status.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type PublicReportsQuery = z.infer<typeof publicReportsQuerySchema>;

export const triageQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Responses.

export const category = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameEn: z.string(),
  nameBn: z.string(),
});

/** Public view: no reporter identity, location rounded to about 100 m, no photos (yet). */
export const publicReportSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  description: z.string(),
  category,
  status,
  latitude: z.number(),
  longitude: z.number(),
  locationDescription: z.string().nullable(),
  organizationName: z.string().nullable(),
  photoCount: z.number().int(),
  submittedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const photo = z.object({
  id: z.uuid(),
  thumbnailUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
});

/** The reporting citizen's own view. */
export const ownReportSchema = publicReportSchema.extend({
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'ORGANIZATION_ONLY', 'RESTRICTED']),
  locationAccuracyM: z.number().int().nullable(),
  routing: z.enum(ROUTING_OUTCOMES),
  version: z.number().int(),
  canEdit: z.boolean(),
  canWithdraw: z.boolean(),
  canProvideInformation: z.boolean(),
  /** The open request from the organization, while the report needs information. */
  informationRequest: z.object({ message: z.string(), requestedAt: z.iso.datetime() }).nullable(),
  rejection: z.object({ reason: z.enum(REJECTION_REASONS), message: z.string() }).nullable(),
  photos: z.array(photo),
  /** The verified fix, once the report is resolved: what was done and after photos. */
  completion: z
    .object({
      description: z.string(),
      photos: z.array(photo),
      resolvedAt: z.iso.datetime(),
    })
    .nullable(),
  canGiveFeedback: z.boolean(),
  /** The citizen's "Is it fixed?" answer for the current resolution. */
  feedback: z.object({ fixed: z.boolean(), comment: z.string().nullable() }).nullable(),
});

/** An organization's message on a report, as citizens and the public see it. */
export const publicUpdateSchema = z.object({
  id: z.uuid(),
  organizationName: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

export const historyEntrySchema = z.object({
  fromStatus: status.nullable(),
  toStatus: status,
  publicMessage: z.string().nullable(),
  /** Only for the reporting citizen. */
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const myReportsSummarySchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
});

export const triageItemSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  category,
  status,
  routing: z.enum(['UNROUTED', 'AMBIGUOUS']),
  candidates: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** Why it is waiting, e.g. the reason an organization sent it back. */
  note: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  locationDescription: z.string().nullable(),
  submittedAt: z.iso.datetime(),
});
