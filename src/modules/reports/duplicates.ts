import type { Prisma } from '../../generated/prisma/client';

/** Used when neither a category nor its parent has a radius (PRD §10.5). */
export const DEFAULT_DUPLICATE_RADIUS_M = 50;
/** Resolved or closed reports remain candidates for this long after resolution. */
export const RESOLVED_CANDIDATE_DAYS = 30;

/**
 * (Re)computes duplicate candidates for one report: reports in the same category family
 * (same category, or sharing a parent), within the category's radius (geodesic metres on the
 * WGS84 geography column, using its GiST index), that are still open or were resolved in the
 * last 30 days. Earlier pending pairs started by this report are replaced, so a moved report
 * gets fresh candidates; decided pairs are kept.
 */
export async function refreshDuplicateCandidates(
  tx: Prisma.TransactionClient,
  reportId: string,
): Promise<number> {
  await tx.duplicateCandidate.deleteMany({ where: { reportId, status: 'PENDING' } });
  return tx.$executeRaw`
    INSERT INTO duplicate_candidates (id, report_id, candidate_id, distance_m, source, status, created_at)
    SELECT gen_random_uuid(), r.id, o.id, ST_Distance(o.location, r.location), 'GEO', 'PENDING', now()
    FROM reports r
    JOIN report_categories c ON c.id = r.category_id
    LEFT JOIN report_categories p ON p.id = c.parent_id
    JOIN reports o ON o.id <> r.id
    JOIN report_categories oc ON oc.id = o.category_id
    WHERE r.id = ${reportId}::uuid
      AND COALESCE(oc.parent_id, oc.id) = COALESCE(c.parent_id, c.id)
      AND ST_DWithin(o.location, r.location,
            COALESCE(c.duplicate_radius_m, p.duplicate_radius_m, ${DEFAULT_DUPLICATE_RADIUS_M}))
      AND o.status NOT IN ('WITHDRAWN', 'REJECTED', 'DUPLICATE')
      AND (o.status NOT IN ('RESOLVED', 'CLOSED')
           OR o.resolved_at >= now() - make_interval(days => ${RESOLVED_CANDIDATE_DAYS}))
      AND NOT EXISTS (
        SELECT 1 FROM duplicate_candidates d
        WHERE (d.report_id = o.id AND d.candidate_id = r.id)
           OR (d.report_id = r.id AND d.candidate_id = o.id))
    ON CONFLICT (report_id, candidate_id) DO NOTHING`;
}

/** Effective radius of a category in metres: its own, else its parent's, else 50 m. */
export async function effectiveRadius(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  categoryId: string,
): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ radius: number }>>`
    SELECT COALESCE(c.duplicate_radius_m, p.duplicate_radius_m, ${DEFAULT_DUPLICATE_RADIUS_M})::int AS radius
    FROM report_categories c LEFT JOIN report_categories p ON p.id = c.parent_id
    WHERE c.id = ${categoryId}::uuid`;
  return row?.radius ?? DEFAULT_DUPLICATE_RADIUS_M;
}
