import { z } from 'zod';

export const serviceAreaSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  areaSqKm: z.number(),
  pointCount: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  previewGeoJson: z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(z.array(z.array(z.number())))),
  }),
});

export const updateServiceAreaSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(200).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');

export const overlapSchema = z.object({
  areaId: z.uuid(),
  areaName: z.string(),
  organizationId: z.uuid(),
  organizationName: z.string(),
  otherAreaId: z.uuid(),
  otherAreaName: z.string(),
  otherOrganizationId: z.uuid(),
  otherOrganizationName: z.string(),
  overlapSqKm: z.number(),
});

export const organizationMatchSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  categoryId: z.uuid().optional(),
});
