import { z } from 'zod';
import { AI_LABELS } from './ai-client';

/**
 * Categories a reviewer might choose for each AI label. The AI never sets a category: these are
 * offered next to the suggestion, and the reviewer picks (PRD §16.2 Task B, §17.6).
 * The model sees cracks but cannot tell their kind, so all three crack categories are offered.
 */
export const SUGGESTED_CATEGORY_SLUGS: Record<(typeof AI_LABELS)[number], string[]> = {
  pothole: ['pothole'],
  crack: ['longitudinal-crack', 'transverse-crack', 'alligator-cracking'],
  asphalt_damage: ['road-damage'],
  no_damage: [],
};

export const aiReviewSchema = z
  .strictObject({
    action: z.enum(['ACCEPTED', 'CORRECTED', 'DISMISSED']),
    /** Required with CORRECTED: what the photo actually shows. */
    correctedLabel: z.enum(AI_LABELS).optional(),
  })
  .refine((input) => (input.action === 'CORRECTED') === (input.correctedLabel !== undefined), {
    message: 'correctedLabel is required with CORRECTED and allowed only then',
    path: ['correctedLabel'],
  });
export type AiReviewInput = z.infer<typeof aiReviewSchema>;

const categorySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameEn: z.string(),
  nameBn: z.string(),
});

export const aiPredictionSchema = z.object({
  id: z.uuid(),
  mediaId: z.uuid(),
  /** Position of the photo in the report (0 = first). */
  photoPosition: z.number().int(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
  modelVersion: z.string().nullable(),
  label: z.enum(AI_LABELS).nullable(),
  /** The model's score for the label: not a guaranteed probability. */
  confidence: z.number().nullable(),
  /** True when the score is under the model's threshold: the reviewer should decide unaided. */
  uncertain: z.boolean().nullable(),
  probabilities: z.record(z.string(), z.number()).nullable(),
  /** Boxes as fractions (0-1) of the photo's width and height: [left, top, right, bottom]. */
  detections: z.array(z.object({ box: z.array(z.number()).length(4), score: z.number() })),
  warnings: z.array(z.string()),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  suggestedCategories: z.array(categorySchema),
  review: z
    .object({
      action: z.enum(['ACCEPTED', 'CORRECTED', 'DISMISSED']),
      correctedLabel: z.enum(AI_LABELS).nullable(),
      reviewedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type AiPredictionView = z.infer<typeof aiPredictionSchema>;

export const aiReportViewSchema = z.object({
  /** Whether new photos are being analysed right now (the AI can be switched off). */
  enabled: z.boolean(),
  /** The latest analysis of each photo. */
  predictions: z.array(aiPredictionSchema),
});

export const aiStatusSchema = z.object({
  enabled: z.boolean(),
  /** The model version the AI service reports, or null when it does not answer. */
  serviceModelVersion: z.string().nullable(),
  last7Days: z.object({
    pending: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    reviewed: z.number().int(),
    accepted: z.number().int(),
    corrected: z.number().int(),
    dismissed: z.number().int(),
    /** Share of reviewed suggestions that reviewers corrected (PRD §19.5). */
    correctionRate: z.number().nullable(),
    medianLatencyMs: z.number().nullable(),
  }),
});
