import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { extractPolygons, GeoJsonError } from './geojson';

/** Approved limits (Phase 3). The 5 MB file limit is enforced by the upload handler. */
export const SERVICE_AREA_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxPoints: 50_000,
  maxAreaSqKm: 10_000,
} as const;

// Preview outlines are simplified (about 50 m) so the browser receives a small payload.
const PREVIEW_TOLERANCE_DEGREES = 0.0005;

/*
 * Coordinate system for every query here: geometries are stored as EPSG:4326 (WGS84
 * longitude/latitude). Point-in-polygon tests use geometry; areas and distances cast to
 * geography so results are in square kilometres / metres on the ellipsoid.
 */

interface Measured {
  valid: boolean;
  reason: string;
  points: number;
  areaSqKm: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ServiceAreaView {
  id: string;
  organizationId: string;
  name: string;
  areaSqKm: number;
  pointCount: number;
  isActive: boolean;
  createdAt: string;
  /** Simplified GeoJSON MultiPolygon for previews. */
  previewGeoJson: unknown;
}

@Injectable()
export class ServiceAreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string): Promise<ServiceAreaView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<
        Omit<ServiceAreaView, 'createdAt' | 'previewGeoJson' | 'areaSqKm'> & {
          areaSqKm: string;
          createdAt: Date;
          preview: string;
        }
      >
    >`
      SELECT id, organization_id AS "organizationId", name, area_sq_km::text AS "areaSqKm",
             point_count AS "pointCount", is_active AS "isActive", created_at AS "createdAt",
             ST_AsGeoJSON(ST_Multi(ST_SimplifyPreserveTopology(geom, ${PREVIEW_TOLERANCE_DEGREES})), 6) AS preview
      FROM service_areas
      WHERE organization_id = ${organizationId}::uuid
      ORDER BY is_active DESC, name ASC`;
    return rows.map(({ preview, createdAt, areaSqKm, ...row }) => ({
      ...row,
      areaSqKm: Number(areaSqKm),
      createdAt: createdAt.toISOString(),
      previewGeoJson: JSON.parse(preview) as unknown,
    }));
  }

  /**
   * Validates an uploaded boundary and stores it. Invalid shapes (self-intersections, wrong
   * coordinate ranges) are rejected with the reason; they are never silently repaired.
   */
  async create(
    organizationId: string,
    name: string,
    fileText: string,
    actorId: string,
    request: Request,
  ): Promise<ServiceAreaView> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new AppException(ErrorCode.NOT_FOUND);

    let polygons;
    try {
      polygons = extractPolygons(fileText);
    } catch (error) {
      if (error instanceof GeoJsonError) throw this.invalid(error.message);
      throw error;
    }
    const geometriesJson = JSON.stringify(polygons);

    let measured: Measured | undefined;
    try {
      [measured] = await this.prisma.$queryRaw<Measured[]>`
        WITH parts AS (
          SELECT (ST_Dump(ST_SetSRID(ST_GeomFromGeoJSON(part::text), 4326))).geom AS geom
          FROM jsonb_array_elements(${geometriesJson}::jsonb) AS part
        ), merged AS (SELECT ST_Multi(ST_Collect(geom)) AS geom FROM parts)
        SELECT ST_IsValid(geom) AS valid, ST_IsValidReason(geom) AS reason,
               ST_NPoints(geom) AS points, ST_Area(geom::geography) / 1e6 AS "areaSqKm",
               ST_XMin(geom) AS "minX", ST_XMax(geom) AS "maxX",
               ST_YMin(geom) AS "minY", ST_YMax(geom) AS "maxY"
        FROM merged`;
    } catch {
      // PostGIS rejects malformed coordinate arrays (e.g. unclosed rings).
      throw this.invalid('The shape could not be read. Check that every ring is closed.');
    }
    if (!measured) throw this.invalid('The file contains no shapes.');
    if (measured.minX < -180 || measured.maxX > 180 || measured.minY < -90 || measured.maxY > 90) {
      throw this.invalid('Coordinates must be longitude (−180 to 180) then latitude (−90 to 90).');
    }
    if (!measured.valid) {
      throw this.invalid(`The shape is not valid: ${measured.reason}.`);
    }
    if (measured.points > SERVICE_AREA_LIMITS.maxPoints) {
      throw this.invalid(
        `The shape has ${measured.points} points; the limit is ${SERVICE_AREA_LIMITS.maxPoints}.`,
      );
    }
    if (measured.areaSqKm > SERVICE_AREA_LIMITS.maxAreaSqKm) {
      throw this.invalid(
        `The area is ${Math.round(measured.areaSqKm)} km²; the limit is ${SERVICE_AREA_LIMITS.maxAreaSqKm} km².`,
      );
    }

    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        WITH parts AS (
          SELECT (ST_Dump(ST_SetSRID(ST_GeomFromGeoJSON(part::text), 4326))).geom AS geom
          FROM jsonb_array_elements(${geometriesJson}::jsonb) AS part
        )
        INSERT INTO service_areas
          (id, organization_id, name, geom, area_sq_km, point_count, created_by_id, updated_at)
        SELECT ${id}::uuid, ${organizationId}::uuid, ${name}, ST_Multi(ST_Collect(geom)),
               ${measured.areaSqKm}, ${measured.points}, ${actorId}::uuid, now()
        FROM parts`;
      await this.audit.record(
        {
          action: 'service_area.created',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: {
            serviceAreaId: id,
            name,
            areaSqKm: Math.round(measured.areaSqKm * 1000) / 1000,
          },
        },
        request,
        tx,
      );
    });

    const created = (await this.list(organizationId)).find((area) => area.id === id);
    if (!created) throw new AppException(ErrorCode.INTERNAL_ERROR);
    return created;
  }

  async update(
    serviceAreaId: string,
    input: { name?: string; isActive?: boolean },
    actorId: string,
    request: Request,
  ): Promise<ServiceAreaView> {
    const existing = await this.prisma.serviceArea.findUnique({
      where: { id: serviceAreaId },
      select: { organizationId: true },
    });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND);
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceArea.update({ where: { id: serviceAreaId }, data: input });
      await this.audit.record(
        {
          action: 'service_area.updated',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: existing.organizationId,
          metadata: { serviceAreaId, ...input },
        },
        request,
        tx,
      );
    });
    const updated = (await this.list(existing.organizationId)).find(
      (area) => area.id === serviceAreaId,
    );
    if (!updated) throw new AppException(ErrorCode.INTERNAL_ERROR);
    return updated;
  }

  /**
   * Active service areas of different organizations that share more than a boundary line.
   * Overlap policy is an open product decision, so these are reported, not resolved.
   */
  async overlaps() {
    const rows = await this.prisma.$queryRaw<
      Array<{
        areaId: string;
        areaName: string;
        organizationId: string;
        organizationName: string;
        otherAreaId: string;
        otherAreaName: string;
        otherOrganizationId: string;
        otherOrganizationName: string;
        overlapSqKm: number;
      }>
    >`
      SELECT a.id AS "areaId", a.name AS "areaName",
             oa.id AS "organizationId", oa.name::text AS "organizationName",
             b.id AS "otherAreaId", b.name AS "otherAreaName",
             ob.id AS "otherOrganizationId", ob.name::text AS "otherOrganizationName",
             ST_Area(ST_Intersection(a.geom, b.geom)::geography) / 1e6 AS "overlapSqKm"
      FROM service_areas a
      JOIN service_areas b
        ON a.id < b.id AND a.organization_id <> b.organization_id
       AND ST_Intersects(a.geom, b.geom) AND NOT ST_Touches(a.geom, b.geom)
      JOIN organizations oa ON oa.id = a.organization_id
      JOIN organizations ob ON ob.id = b.organization_id
      WHERE a.is_active AND b.is_active
      ORDER BY "overlapSqKm" DESC`;
    return rows.map((row) => ({ ...row, overlapSqKm: Math.round(row.overlapSqKm * 1000) / 1000 }));
  }

  /**
   * Verified, active organizations whose active service areas cover a point, optionally only
   * those handling a category. Basis for report routing (Phase 5); nearest is never assumed.
   */
  async organizationsCovering(latitude: number, longitude: number, categoryId?: string) {
    return this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT DISTINCT o.id, o.name::text AS name
      FROM service_areas sa
      JOIN organizations o ON o.id = sa.organization_id
      WHERE sa.is_active AND o.is_active AND o.verification_state = 'VERIFIED'
        AND ST_Covers(sa.geom, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326))
        AND (${categoryId ?? null}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM organization_categories oc
          WHERE oc.organization_id = o.id AND oc.category_id = ${categoryId ?? null}::uuid))
      ORDER BY name`;
  }

  private invalid(message: string): AppException {
    return new AppException(ErrorCode.VALIDATION_ERROR, message, [{ field: 'file', message }]);
  }
}
