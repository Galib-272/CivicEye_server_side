import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = { data: T; error?: { code: string; message: string } };
type Related = { publicId: string; distanceM: number; status: string };

const NORTH = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const SOUTH = { minLon: 90.46, minLat: 23.7, maxLon: 90.5, maxLat: 23.76 };
const BASE = { latitude: 23.86, longitude: 90.37 };
/** About 20 m and 100 m north of BASE (1° latitude ≈ 111 km). */
const NEAR_20M = { latitude: 23.86018, longitude: 90.37 };
const NEAR_100M = { latitude: 23.8609, longitude: 90.37 };

describe('Map, nearby reports and duplicates (real PostGIS)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let reviewer: Client;
  let southReviewer: Client;
  let admin: Client;
  let anonymous: Client;
  let northId: string;
  let southId: string;
  let potholeId: string;
  let garbageId: string;

  async function verifiedOrganization(name: string, area: typeof NORTH) {
    const organization = await h.prisma.organization.create({
      data: {
        name,
        officialEmailDomain: `${randomUUID().slice(0, 8)}.gov.bd`,
        verificationState: 'VERIFIED',
      },
    });
    await h.prisma.$executeRaw`
      INSERT INTO service_areas (id, organization_id, name, geom, area_sq_km, point_count, created_by_id, updated_at)
      SELECT ${randomUUID()}::uuid, ${organization.id}::uuid, ${name},
             ST_Multi(ST_MakeEnvelope(${area.minLon}, ${area.minLat}, ${area.maxLon}, ${area.maxLat}, 4326)),
             100, 5, u.id, now()
      FROM users u LIMIT 1`;
    for (const categoryId of [potholeId, garbageId]) {
      await h.prisma.organizationCategory.create({
        data: { organizationId: organization.id, categoryId },
      });
    }
    return organization.id;
  }

  async function reviewerOf(email: string, organizationId: string) {
    const { client, userId } = await h.signedIn(email, 'Reviewer');
    await h.prisma.organizationMember.create({
      data: { organizationId, userId, role: 'ORG_REVIEWER', status: 'ACTIVE' },
    });
    return client;
  }

  async function uploadPhoto() {
    const content = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#334455' },
    })
      .jpeg()
      .toBuffer();
    const intent = await citizen
      .post('/media/upload-intent', { contentType: 'image/jpeg', byteSize: content.length })
      .expect(201);
    const { mediaId, uploadUrl } = (intent.body as Body<{ mediaId: string; uploadUrl: string }>)
      .data;
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: content,
    });
    await citizen.post(`/media/${mediaId}/confirm`).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const view = await citizen.get(`/media/${mediaId}`).expect(200);
      if ((view.body as Body<{ status: string }>).data.status === 'PROCESSED') return mediaId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Photo was not processed in time');
  }

  async function submit(
    location: { latitude: number; longitude: number },
    options: { categoryId?: string; visibility?: 'PUBLIC' | 'PRIVATE'; title?: string } = {},
  ) {
    const response = await citizen
      .post('/reports', {
        title: options.title ?? 'Deep pothole near the bus stop',
        description: 'A deep pothole that fills with water when it rains.',
        categoryId: options.categoryId ?? potholeId,
        ...location,
        visibility: options.visibility ?? 'PUBLIC',
        mediaIds: [await uploadPhoto()],
      })
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return (response.body as Body<{ publicId: string }>).data.publicId;
  }

  const base = (publicId: string, organizationId = northId) =>
    `/organizations/${organizationId}/reports/${publicId}`;

  async function candidates(publicId: string) {
    const response = await reviewer.get(`${base(publicId)}/duplicates`).expect(200);
    return (response.body as Body<Related[]>).data;
  }

  async function markDuplicate(publicId: string, canonicalPublicId: string, status = 200) {
    const view = await reviewer.get(base(publicId)).expect(200);
    const { version } = (view.body as Body<{ version: number }>).data;
    return reviewer
      .post(`${base(publicId)}/mark-duplicate`, {
        canonicalPublicId,
        reason: 'Same pothole, reported twice from the bus stop.',
      })
      .set('If-Match', String(version))
      .expect(status);
  }

  beforeAll(async () => {
    h = await startAuthHarness([], { runWorkers: true });
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    garbageId = (
      await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'garbage-accumulation' } })
    ).id;
    ({ client: citizen } = await h.signedIn('citizen@example.test', 'Rahima Akter'));
    northId = await verifiedOrganization('Dhaka North', NORTH);
    southId = await verifiedOrganization('Dhaka South', SOUTH);
    reviewer = await reviewerOf('reviewer@north.gov.bd', northId);
    southReviewer = await reviewerOf('reviewer@south.gov.bd', southId);
    admin = await h.superAdmin('root@civiceye.test');
    anonymous = h.client();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
  });

  it('finds candidates within the category radius, in both directions', async () => {
    const first = await submit(BASE);
    const second = await submit(NEAR_20M);
    const farther = await submit(NEAR_100M);
    const garbage = await submit(NEAR_20M, {
      categoryId: garbageId,
      title: 'Garbage pile by the bus stop',
    });

    const forSecond = await candidates(second);
    expect(forSecond.map((item) => item.publicId)).toContain(first);
    expect(forSecond.find((item) => item.publicId === first)?.distanceM).toBeGreaterThan(15);
    expect(forSecond.find((item) => item.publicId === first)?.distanceM).toBeLessThan(25);
    // 100 m is outside the 30 m pothole radius; garbage is another category family.
    expect(forSecond.map((item) => item.publicId)).not.toContain(farther);
    expect(forSecond.map((item) => item.publicId)).not.toContain(garbage);
    // The older report sees the newer one too.
    expect((await candidates(first)).map((item) => item.publicId)).toContain(second);

    // Super Admins tune the radius per category; new reports use it.
    await admin.patch(`/admin/categories/${potholeId}`, { duplicateRadiusM: 150 }).expect(200);
    try {
      const wider = await submit({ latitude: 23.8609, longitude: 90.3701 });
      expect((await candidates(wider)).map((item) => item.publicId)).toEqual(
        expect.arrayContaining([first, farther]),
      );
    } finally {
      await admin.patch(`/admin/categories/${potholeId}`, { duplicateRadiusM: 30 }).expect(200);
    }
    await admin.patch(`/admin/categories/${potholeId}`, { duplicateRadiusM: 5 }).expect(400);
  });

  it('links a duplicate to its original and tells the citizen', async () => {
    const original = await submit({ latitude: 23.85, longitude: 90.38 });
    const copy = await submit({ latitude: 23.85005, longitude: 90.38 });
    expect((await candidates(copy)).map((item) => item.publicId)).toContain(original);

    await markDuplicate(copy, copy, 400); // never itself
    await markDuplicate(copy, original);

    const own = await citizen.get(`/reports/${copy}`).expect(200);
    expect(
      (own.body as Body<{ status: string; duplicateOf: { publicId: string } }>).data,
    ).toMatchObject({
      status: 'DUPLICATE',
      duplicateOf: { publicId: original },
    });
    const decision = await h.prisma.duplicateDecision.findFirstOrThrow({
      where: { report: { publicId: copy } },
    });
    expect(decision.decision).toBe('CONFIRMED');

    // Final, no chains: the copy cannot change, and the original cannot become a duplicate.
    await markDuplicate(copy, original, 422);
    const third = await submit({ latitude: 23.85002, longitude: 90.38 });
    await markDuplicate(original, third, 422);
    // A duplicate cannot be anyone's original either.
    await markDuplicate(third, copy, 422);

    // The citizen is notified.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const list = await citizen.get('/notifications').expect(200);
      const types = (list.body as Body<Array<{ type: string; reportPublicId: string }>>).data;
      if (types.some((n) => n.type === 'REPORT_DUPLICATE' && n.reportPublicId === copy)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('No REPORT_DUPLICATE notification');
  });

  it('only links reports of the same organization, and the database enforces the link', async () => {
    const north = await submit({ latitude: 23.84, longitude: 90.39 });
    const south = await submit({ latitude: 23.72, longitude: 90.48 });
    await markDuplicate(north, south, 400);
    await southReviewer.get(`${base(north, southId)}/duplicates`).expect(404);
    await reviewer.get(`${base(north)}/duplicates`).expect(200);
    await expect(
      h.prisma.report.update({ where: { publicId: north }, data: { status: 'DUPLICATE' } }),
    ).rejects.toThrow(/reports_duplicate_link_check/);
  });

  it('dismisses a candidate for good', async () => {
    const one = await submit({ latitude: 23.83, longitude: 90.4 });
    const two = await submit({ latitude: 23.83003, longitude: 90.4 });
    await reviewer
      .post(`${base(two)}/dismiss-duplicate`, {
        candidatePublicId: one,
        reason: 'Other side of the road.',
      })
      .expect(200);
    expect((await candidates(two)).map((item) => item.publicId)).not.toContain(one);
    expect((await candidates(one)).map((item) => item.publicId)).not.toContain(two);
    const decision = await h.prisma.duplicateDecision.findFirstOrThrow({
      where: { report: { publicId: two }, decision: 'DISMISSED' },
    });
    await expect(h.prisma.duplicateDecision.delete({ where: { id: decision.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('searches the organization’s reports by distance', async () => {
    const center = await submit({ latitude: 23.82, longitude: 90.41 });
    const close = await submit(
      { latitude: 23.8209, longitude: 90.41 },
      { categoryId: garbageId, title: 'Garbage 100 m away' },
    );
    const response = await reviewer.get(`${base(center)}/nearby?radius=150`).expect(200);
    const found = (response.body as Body<Related[]>).data;
    expect(found.map((item) => item.publicId)).toContain(close);
    await reviewer.get(`${base(center)}/nearby?radius=5000`).expect(400);
  });

  it('serves the public map with rounded locations and no private or hidden reports', async () => {
    const visible = await submit({ latitude: 23.81234, longitude: 90.42345 });
    const hidden = await submit(
      { latitude: 23.8124, longitude: 90.4235 },
      { visibility: 'PRIVATE' },
    );
    const query = 'minLng=90.40&minLat=23.80&maxLng=90.44&maxLat=23.82';
    const response = await anonymous.get(`/map/reports?${query}`).expect(200);
    const { reports } = (
      response.body as Body<{
        reports: Array<{ publicId: string; latitude: number; longitude: number }>;
      }>
    ).data;
    const point = reports.find((item) => item.publicId === visible);
    expect(point).toMatchObject({ latitude: 23.812, longitude: 90.423 });
    expect(reports.map((item) => item.publicId)).not.toContain(hidden);
    expect(JSON.stringify(response.body)).not.toContain('Rahima');

    const filtered = await anonymous
      .get(`/map/reports?${query}&categoryId=${garbageId}`)
      .expect(200);
    expect(JSON.stringify(filtered.body)).not.toContain(visible);
    await anonymous.get('/map/reports?minLng=80&minLat=10&maxLng=95&maxLat=30').expect(400);

    const areas = await anonymous.get('/map/organizations').expect(200);
    expect((areas.body as Body<Array<{ name: string; geometry: { type: string } }>>).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Dhaka North',
          geometry: expect.objectContaining({ type: 'MultiPolygon' }),
        }),
      ]),
    );
  });

  it('warns citizens about nearby public reports and says who would handle a point', async () => {
    const existing = await submit({ latitude: 23.805, longitude: 90.43 });
    const secret = await submit(
      { latitude: 23.80501, longitude: 90.43 },
      { visibility: 'PRIVATE' },
    );
    const nearby = await anonymous
      .get(`/map/nearby?latitude=23.8051&longitude=90.43&categoryId=${potholeId}`)
      .expect(200);
    const ids = (nearby.body as Body<Array<{ publicId: string }>>).data.map(
      (item) => item.publicId,
    );
    expect(ids).toContain(existing);
    expect(ids).not.toContain(secret);

    // The existing Phase 3 endpoint lists the organizations covering a point.
    const routed = await anonymous
      .post('/locations/organization-match', {
        latitude: 23.85,
        longitude: 90.4,
        categoryId: potholeId,
      })
      .expect(200);
    expect((routed.body as Body<Array<{ id: string }>>).data.map((o) => o.id)).toEqual([northId]);
    const nowhere = await anonymous
      .post('/locations/organization-match', { latitude: 22.35, longitude: 91.78 })
      .expect(200);
    expect((nowhere.body as Body<unknown[]>).data).toEqual([]);
  });
});
