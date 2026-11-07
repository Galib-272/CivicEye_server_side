import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodQuery, ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import type { ReportStatus } from '../../generated/prisma/enums';
import { Public } from '../auth/auth.decorators';
import { effectiveRadius, RESOLVED_CANDIDATE_DAYS } from './duplicates';
import { roundForPublic } from './reports.service';
import { SERVICE_BOUNDS, status } from './reports.schemas';

const latitude = z.coerce.number().min(SERVICE_BOUNDS.minLat).max(SERVICE_BOUNDS.maxLat);
const longitude = z.coerce.number().min(SERVICE_BOUNDS.minLng).max(SERVICE_BOUNDS.maxLng);
/** Largest map view served at once (about 330 km across); zoom in for more detail. */
const MAX_SPAN_DEGREES = 3;
const MAX_POINTS = 2000;

export const mapQuerySchema = z
  .strictObject({
    minLng: z.coerce.number().min(-180).max(180),
    minLat: z.coerce.number().min(-90).max(90),
    maxLng: z.coerce.number().min(-180).max(180),
    maxLat: z.coerce.number().min(-90).max(90),
    categoryId: z.uuid().optional(),
    status: status.optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine((value) => value.minLng < value.maxLng && value.minLat < value.maxLat, {
    message: 'The box must have its minimum below its maximum.',
  })
  .refine(
    (value) =>
      value.maxLng - value.minLng <= MAX_SPAN_DEGREES &&
      value.maxLat - value.minLat <= MAX_SPAN_DEGREES,
    { message: 'Zoom in: the map area is too large.' },
  );
type MapQuery = z.infer<typeof mapQuerySchema>;

const mapPointSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  status,
  categoryId: z.uuid(),
  latitude: z.number(),
  longitude: z.number(),
  submittedAt: z.iso.datetime(),
});
const mapResponseSchema = z.object({
  reports: z.array(mapPointSchema),
  /** True when more than 2,000 reports are in view; zoom in to see all. */
  truncated: z.boolean(),
});

const areaSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** GeoJSON MultiPolygon in WGS84 (EPSG:4326), simplified for display. */
  geometry: z.object({ type: z.string(), coordinates: z.array(z.unknown()) }),
});

const nearbyQuerySchema = z.strictObject({
  latitude,
  longitude,
  categoryId: z.uuid(),
});
const nearbyReportSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  status,
  /** Rounded to 10 m; the report's own location stays rounded to about 100 m. */
  distanceM: z.number().int(),
  submittedAt: z.iso.datetime(),
});

/** The citizen's pin may be off by a few metres, so the warning looks a little wider. */
const NEARBY_FACTOR = 2;
const NEARBY_MAX_M = 300;

/**
 * Public map data (PRD §10.1, §14.9). Only public reports, never withdrawn or duplicates,
 * never the reporter, and locations rounded to about 100 m exactly as on report pages.
 * All coordinates are WGS84 (EPSG:4326); distances are geodesic metres (PostGIS geography).
 */
@ApiTags('map')
@Controller({ version: '1' })
export class MapController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('map/reports')
  @Public()
  @ApiOperation({ summary: 'Public reports inside a map box (at most 2,000; zoom in for more).' })
  @ApiZodQuery(mapQuerySchema)
  @ApiZodResponse(mapResponseSchema)
  @ApiErrorResponses(400)
  async reports(@Query(new ZodValidationPipe(mapQuerySchema)) query: MapQuery) {
    const from = query.from ? new Date(`${query.from}T00:00:00Z`) : null;
    const to = query.to ? new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000) : null;
    const rows = await this.prisma.$queryRaw<
      Array<{
        public_id: string;
        title: string;
        status: ReportStatus;
        category_id: string;
        latitude: number;
        longitude: number;
        submitted_at: Date;
      }>
    >`
      SELECT public_id, title, status, category_id,
             latitude::float8 AS latitude, longitude::float8 AS longitude, submitted_at
      FROM reports
      WHERE visibility = 'PUBLIC'
        AND status NOT IN ('WITHDRAWN', 'DUPLICATE')
        AND location && ST_MakeEnvelope(${query.minLng}, ${query.minLat}, ${query.maxLng}, ${query.maxLat}, 4326)::geography
        AND (${query.categoryId ?? null}::uuid IS NULL OR category_id = ${query.categoryId ?? null}::uuid)
        AND (${query.status ?? null}::text IS NULL OR status::text = ${query.status ?? null}::text)
        AND (${from}::timestamptz IS NULL OR submitted_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR submitted_at < ${to}::timestamptz)
      ORDER BY submitted_at DESC
      LIMIT ${MAX_POINTS + 1}`;
    return {
      reports: rows.slice(0, MAX_POINTS).map((row) => ({
        publicId: row.public_id,
        title: row.title,
        status: row.status,
        categoryId: row.category_id,
        latitude: roundForPublic(row.latitude),
        longitude: roundForPublic(row.longitude),
        submittedAt: row.submitted_at.toISOString(),
      })),
      truncated: rows.length > MAX_POINTS,
    };
  }

  @Get('map/organizations')
  @Public()
  @ApiOperation({ summary: 'Areas covered by verified organizations (simplified outlines).' })
  @ApiZodResponse(z.array(areaSchema))
  async organizations() {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; geometry: string }>>`
      SELECT o.id, o.name::text AS name,
             ST_AsGeoJSON(ST_Multi(ST_SimplifyPreserveTopology(ST_Union(sa.geom), 0.0005)), 5) AS geometry
      FROM organizations o
      JOIN service_areas sa ON sa.organization_id = o.id AND sa.is_active
      WHERE o.is_active AND o.verification_state = 'VERIFIED'
      GROUP BY o.id, o.name
      ORDER BY o.name`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      geometry: JSON.parse(row.geometry) as { type: string; coordinates: unknown[] },
    }));
  }

  @Get('map/nearby')
  @Public()
  @ApiOperation({
    summary:
      'Public reports of the same category family near a point, to check before reporting again.',
  })
  @ApiZodQuery(nearbyQuerySchema)
  @ApiZodResponse(z.array(nearbyReportSchema))
  @ApiErrorResponses(400)
  async nearby(
    @Query(new ZodValidationPipe(nearbyQuerySchema)) query: z.infer<typeof nearbyQuerySchema>,
  ) {
    const radius = Math.min(
      (await effectiveRadius(this.prisma, query.categoryId)) * NEARBY_FACTOR,
      NEARBY_MAX_M,
    );
    const rows = await this.prisma.$queryRaw<
      Array<{
        public_id: string;
        title: string;
        status: ReportStatus;
        distance_m: number;
        submitted_at: Date;
      }>
    >`
      WITH point AS (
        SELECT ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography AS g
      ), family AS (
        SELECT COALESCE(parent_id, id) AS root FROM report_categories WHERE id = ${query.categoryId}::uuid
      )
      SELECT r.public_id, r.title, r.status,
             (round(ST_Distance(r.location, point.g) / 10) * 10)::int AS distance_m, r.submitted_at
      FROM reports r
      JOIN report_categories c ON c.id = r.category_id, point, family
      WHERE r.visibility = 'PUBLIC'
        AND r.status NOT IN ('WITHDRAWN', 'REJECTED', 'DUPLICATE')
        AND (r.status NOT IN ('RESOLVED', 'CLOSED')
             OR r.resolved_at >= now() - make_interval(days => ${RESOLVED_CANDIDATE_DAYS}))
        AND COALESCE(c.parent_id, c.id) = family.root
        AND ST_DWithin(r.location, point.g, ${radius})
      ORDER BY ST_Distance(r.location, point.g) ASC
      LIMIT 10`;
    return rows.map((row) => ({
      publicId: row.public_id,
      title: row.title,
      status: row.status,
      distanceM: row.distance_m,
      submittedAt: row.submitted_at.toISOString(),
    }));
  }
}
