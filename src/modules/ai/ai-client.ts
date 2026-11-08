import { z } from 'zod';
import type { AppConfig } from '../../config/app-config';

/** What the road damage model can say about a photo (ml/models/manifest.json). */
export const AI_LABELS = ['pothole', 'crack', 'asphalt_damage', 'no_damage'] as const;
export type AiLabel = (typeof AI_LABELS)[number];

const fraction = z.number().min(0).max(1);

/** The AI service's answer. Checked strictly: nothing unexpected is stored or shown. */
export const analysisSchema = z.object({
  modelVersion: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[\w.-]+$/),
  label: z.enum(AI_LABELS),
  confidence: fraction,
  uncertain: z.boolean(),
  probabilities: z.object({
    pothole: fraction,
    crack: fraction,
    asphalt_damage: fraction,
    no_damage: fraction,
  }),
  damageProbability: fraction,
  detections: z
    .array(z.object({ box: z.tuple([fraction, fraction, fraction, fraction]), score: fraction }))
    .max(20),
  quality: z.object({
    brightness: fraction,
    sharpness: z.number().min(0),
    warnings: z.array(z.enum(['too_dark', 'blurry'])).max(5),
  }),
  timingsMs: z.record(z.string().max(30), z.number().min(0)),
});
export type Analysis = z.infer<typeof analysisSchema>;

/**
 * Why an analysis failed. `rejected_image`, `bad_response` and `unauthorized` will not change on
 * a retry; the others might.
 */
export type AiErrorCode =
  'unreachable' | 'timeout' | 'server_error' | 'rejected_image' | 'bad_response' | 'unauthorized';

const PERMANENT: ReadonlySet<AiErrorCode> = new Set([
  'rejected_image',
  'bad_response',
  'unauthorized',
]);

export class AiServiceError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }

  get permanent(): boolean {
    return PERMANENT.has(this.code);
  }
}

type AiConfig = AppConfig['ai'];

function endpoint(config: AiConfig, path: string): string {
  return new URL(
    path,
    config.serviceUrl.endsWith('/') ? config.serviceUrl : `${config.serviceUrl}/`,
  ).href;
}

async function call(config: AiConfig, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(endpoint(config, path), {
      ...init,
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new AiServiceError('timeout', `No answer within ${config.timeoutMs} ms`);
    }
    throw new AiServiceError('unreachable', 'The AI service could not be reached');
  }
}

/** Sends one photo (JPEG) to the AI service and returns its checked answer. */
export async function analyzePhoto(config: AiConfig, photo: Buffer): Promise<Analysis> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg');
  const response = await call(config, 'v1/analyze', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}` },
    body: form,
  });
  if (response.status === 401) {
    throw new AiServiceError('unauthorized', 'The AI service refused the token');
  }
  if (response.status === 413 || response.status === 422) {
    throw new AiServiceError('rejected_image', `The AI service could not read the photo`);
  }
  if (!response.ok) {
    throw new AiServiceError('server_error', `The AI service answered ${response.status}`);
  }
  const parsed = analysisSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new AiServiceError('bad_response', 'The AI service answered in an unexpected format');
  }
  return parsed.data;
}

/** The model version the service has loaded, or null when it does not answer. */
export async function serviceVersion(config: AiConfig): Promise<string | null> {
  try {
    const response = await call(config, 'health', { method: 'GET' });
    if (!response.ok) return null;
    const body = z.object({ modelVersion: z.string().max(60) }).safeParse(await response.json());
    return body.success ? body.data.modelVersion : null;
  } catch {
    return null;
  }
}
