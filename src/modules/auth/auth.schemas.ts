import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from './password-policy';

// Requests. Strict objects reject unknown keys, so clients cannot smuggle fields such as role.

const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const locale = z.enum(['en', 'bn']);
// Detailed password rules are applied by PasswordService so failures carry issue codes.
const newPassword = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH * 4);
const token = z.string().min(20).max(200);

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email,
  password: newPassword,
  preferredLocale: locale.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.strictObject({
  email,
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 4),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const tokenSchema = z.strictObject({ token });

export const forgotPasswordSchema = z.strictObject({ email });

export const resetPasswordSchema = z.strictObject({ token, newPassword });

export const mfaCodeSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

export const mfaChallengeSchema = z.union([
  z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({ backupCode: z.string().trim().min(8).max(20) }),
]);
export type MfaChallengeInput = z.infer<typeof mfaChallengeSchema>;

export const sessionIdParamSchema = z.uuid();

// Responses (documentation and tests; controllers build these shapes explicitly).

export const selfUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  status: z.enum(['PENDING_VERIFICATION', 'ACTIVE']),
  platformRole: z.enum(['CITIZEN', 'SUPER_ADMIN']),
  preferredLocale: locale,
  emailVerified: z.boolean(),
});

export const mfaStateSchema = z.enum(['none', 'pending', 'setup_required', 'verified']);

export const authStateSchema = z.object({
  user: selfUserSchema,
  csrfToken: z.string(),
  mfa: mfaStateSchema,
});
export type AuthState = z.infer<typeof authStateSchema>;

export const acceptedSchema = z.object({ accepted: z.literal(true) });

export const mfaSetupSchema = z.object({
  otpauthUri: z.string(),
  secret: z.string(),
});

export const mfaEnabledSchema = z.object({
  backupCodes: z.array(z.string()),
  auth: authStateSchema,
});

export const sessionSchema = z.object({
  id: z.uuid(),
  current: z.boolean(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
