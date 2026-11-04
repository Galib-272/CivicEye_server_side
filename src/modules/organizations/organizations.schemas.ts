import { z } from 'zod';

/**
 * Approved verification rule: the contact must use an official government email domain.
 * Launch is in Bangladesh, where government bodies use subdomains of gov.bd.
 */
export const GOVERNMENT_DOMAIN_SUFFIXES = ['.gov.bd'] as const;

const domainPattern = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const officialDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .regex(domainPattern, 'Enter a domain such as example.gov.bd.')
      .refine((value) => GOVERNMENT_DOMAIN_SUFFIXES.some((suffix) => value.endsWith(suffix)), {
        message: `Must be a government domain ending in ${GOVERNMENT_DOMAIN_SUFFIXES.join(' or ')}.`,
      }),
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const website = z
  .url({ protocol: /^https$/, message: 'Use an https:// address.' })
  .max(300)
  .nullable()
  .optional();
const publicEmail = z.email().max(254).nullable().optional();
const publicPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,30}$/, 'Enter a valid phone number.')
  .nullable()
  .optional();

export const profileFieldsSchema = {
  description: optionalText(2000),
  website,
  publicEmail,
  publicPhone,
};

export const createOrganizationSchema = z.strictObject({
  name: z.string().trim().min(2).max(200),
  type: z.enum(['CITY_CORPORATION']).default('CITY_CORPORATION'),
  officialEmailDomain: officialDomainSchema,
  ...profileFieldsSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/** Fields an Org Admin may edit. Name, type and official domain are Super Admin only. */
export const updateProfileSchema = z
  .strictObject(profileFieldsSchema)
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const adminUpdateOrganizationSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(200).optional(),
    officialEmailDomain: officialDomainSchema.optional(),
    ...profileFieldsSchema,
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');
export type AdminUpdateOrganizationInput = z.infer<typeof adminUpdateOrganizationSchema>;

export const verificationContactSchema = z.strictObject({
  name: z.string().trim().min(2).max(100),
  jobTitle: z.string().trim().min(2).max(100),
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
});
export type VerificationContactInput = z.infer<typeof verificationContactSchema>;

export const reasonSchema = z.strictObject({ reason: z.string().trim().min(5).max(1000) });
export const optionalReasonSchema = z.strictObject({
  reason: z.string().trim().min(5).max(1000).optional(),
});

export const organizationRoleSchema = z.enum(['ORG_ADMIN', 'ORG_REVIEWER', 'WORKER']);

export const inviteSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  role: organizationRoleSchema,
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const changeRoleSchema = z.strictObject({ role: organizationRoleSchema });

export const listOrganizationsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().min(1).max(200).optional(),
  verificationState: z
    .enum(['UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'SUSPENDED'])
    .optional(),
});
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;

export const publicListQuerySchema = listOrganizationsQuerySchema.omit({
  verificationState: true,
});

export const setCategoriesSchema = z.strictObject({
  categoryIds: z.array(z.uuid()).max(100),
});

export const tokenBodySchema = z.strictObject({ token: z.string().min(20).max(200) });

// Responses.

const verificationState = z.enum([
  'UNVERIFIED',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
]);

export const publicOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['CITY_CORPORATION']),
  description: z.string().nullable(),
  website: z.string().nullable(),
  publicEmail: z.string().nullable(),
  publicPhone: z.string().nullable(),
});

export const organizationOverviewSchema = publicOrganizationSchema.extend({
  officialEmailDomain: z.string(),
  verificationState,
  isActive: z.boolean(),
  memberCount: z.number().int(),
  categoryIds: z.array(z.uuid()),
  myRole: organizationRoleSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const verificationContactViewSchema = z.object({
  name: z.string(),
  jobTitle: z.string(),
  email: z.string(),
  confirmedAt: z.iso.datetime().nullable(),
  linkExpiresAt: z.iso.datetime().nullable(),
});

export const verificationRecordSchema = z.object({
  fromState: verificationState,
  toState: verificationState,
  reason: z.string().nullable(),
  decidedBy: z.string(),
  createdAt: z.iso.datetime(),
});

export const adminOrganizationSchema = organizationOverviewSchema.extend({
  verificationContact: verificationContactViewSchema.nullable(),
  verificationHistory: z.array(verificationRecordSchema),
});

export const adminOrganizationListItemSchema = organizationOverviewSchema.omit({
  myRole: true,
  categoryIds: true,
});

export const memberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: organizationRoleSchema,
  joinedAt: z.iso.datetime().nullable(),
});

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: organizationRoleSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const myOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: organizationRoleSchema,
  verificationState,
  isActive: z.boolean(),
});
