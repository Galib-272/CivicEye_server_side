import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { STRONG_PASSWORD, startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = {
  data: T;
  meta?: { total: number };
  error?: { code: string; message: string; details: Array<{ field?: string; message: string }> };
};

type OwnReport = {
  publicId: string;
  status: string;
  routing: string;
  version: number;
  latitude: number;
  longitude: number;
  canEdit: boolean;
  canWithdraw: boolean;
  organizationName: string | null;
  photos: Array<{ id: string; thumbnailUrl: string | null; displayUrl: string | null }>;
};

const NORTH = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const SOUTH = { minLon: 90.4, minLat: 23.7, maxLon: 90.5, maxLat: 23.82 }; // overlaps NORTH
const IN_NORTH_ONLY = { latitude: 23.86, longitude: 90.37 };
const IN_BOTH = { latitude: 23.8, longitude: 90.42 };
const OUTSIDE_ALL = { latitude: 22.35, longitude: 91.78 }; // Chattogram

function gpsPhoto(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#6b7c8d' } })
    .jpeg()
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '23/1 48/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '90/1 24/1 0/1',
      },
    })
    .toBuffer();
}

describe('Reports and photos (real PostGIS, Redis and S3-compatible storage)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let potholeId: string;
  let northId: string;

  async function verifiedOrganization(name: string, domain: string, area: typeof NORTH) {
    const organization = await h.prisma.organization.create({
      data: { name, officialEmailDomain: domain, verificationState: 'VERIFIED' },
      select: { id: true },
    });
    await h.prisma.$executeRaw`
      INSERT INTO service_areas (id, organization_id, name, geom, area_sq_km, point_count, created_by_id, updated_at)
      SELECT ${randomUUID()}::uuid, ${organization.id}::uuid, ${`${name} area`},
             ST_Multi(ST_MakeEnvelope(${area.minLon}, ${area.minLat}, ${area.maxLon}, ${area.maxLat}, 4326)),
             100, 5, u.id, now()
      FROM users u LIMIT 1`;
    await h.prisma.organizationCategory.create({
      data: { organizationId: organization.id, categoryId: potholeId },
    });
    return organization.id;
  }

  async function uploadPhoto(client: Client, file?: Buffer, contentType = 'image/jpeg') {
    const content = file ?? (await gpsPhoto());
    const intent = await client
      .post('/media/upload-intent', { contentType, byteSize: content.length })
      .expect(201);
    const { mediaId, uploadUrl } = (intent.body as Body<{ mediaId: string; uploadUrl: string }>)
      .data;
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: content,
    });
    expect(put.status).toBe(200);
    await client.post(`/media/${mediaId}/confirm`).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const view = await client.get(`/media/${mediaId}`).expect(200);
      const data = (
        view.body as Body<{
          status: string;
          rejectionReason: string | null;
          displayUrl: string | null;
        }>
      ).data;
      if (data.status !== 'UPLOADED') return { mediaId, ...data };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Photo was not processed in time');
  }

  /** Uploads a photo and submits a report with it, expecting the given HTTP status. */
  async function submit(client: Client, overrides: Record<string, unknown> = {}, status = 201) {
    const { mediaId } = await uploadPhoto(client);
    return client
      .post('/reports', {
        title: 'Deep pothole near the bus stop',
        description: 'A deep pothole that fills with water when it rains.',
        categoryId: potholeId,
        ...IN_NORTH_ONLY,
        mediaIds: [mediaId],
        ...overrides,
      })
      .set('Idempotency-Key', randomUUID())
      .expect(status);
  }

  beforeAll(async () => {
    h = await startAuthHarness([], { runWorkers: true });
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    ({ client: citizen } = await h.signedIn('citizen@example.test', 'Rahima Akter'));
    northId = await verifiedOrganization('Dhaka North City Corporation', 'dncc.gov.bd', NORTH);
    await verifiedOrganization('Dhaka South City Corporation', 'dscc.gov.bd', SOUTH);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
  });

  describe('photo uploads', () => {
    it('strips GPS and all other metadata and deletes the original upload', async () => {
      const original = await gpsPhoto();
      expect((await sharp(original).metadata()).exif).toBeDefined();

      const photo = await uploadPhoto(citizen, original);
      expect(photo.status).toBe('PROCESSED');
      const display = Buffer.from(await (await fetch(photo.displayUrl ?? '')).arrayBuffer());
      const metadata = await sharp(display).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.exif).toBeUndefined();

      const record = await h.prisma.reportMedia.findUniqueOrThrow({ where: { id: photo.mediaId } });
      expect(record.sha256).toBe(createHash('sha256').update(original).digest('hex'));
      const leftover = await fetch(
        `${h.env.config().storage.endpoint}/civiceye-test/${record.originalKey}`,
      );
      expect(leftover.status).not.toBe(200);
    });

    it('rejects a file whose content is not an image, whatever its declared type', async () => {
      const photo = await uploadPhoto(citizen, Buffer.from('definitely not a JPEG '.repeat(50)));
      expect(photo.status).toBe('REJECTED');
      expect(photo.rejectionReason).toMatch(/not a readable image/);
    });

    it('refuses other formats and oversized files before upload', async () => {
      await citizen
        .post('/media/upload-intent', { contentType: 'image/gif', byteSize: 100 })
        .expect(400);
      await citizen
        .post('/media/upload-intent', { contentType: 'image/heic', byteSize: 100 })
        .expect(400);
      await citizen
        .post('/media/upload-intent', { contentType: 'image/jpeg', byteSize: 10 * 1024 * 1024 + 1 })
        .expect(400);
    });

    it('requires a verified email to upload', async () => {
      await h.createUser({ email: 'unverified@example.test', verified: false });
      const unverified = h.client();
      await unverified.login('unverified@example.test', STRONG_PASSWORD);
      const response = await unverified
        .post('/media/upload-intent', { contentType: 'image/jpeg', byteSize: 100 })
        .expect(403);
      expect((response.body as Body).error?.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('hides other users’ photos', async () => {
      const photo = await uploadPhoto(citizen);
      const { client: other } = await h.signedIn('other-photo@example.test');
      await other.get(`/media/${photo.mediaId}`).expect(404);
      await other.delete(`/media/${photo.mediaId}`).expect(404);
    });
  });

  describe('submission and routing', () => {
    it('routes to the single verified organization covering the point', async () => {
      const response = await submit(citizen);
      const report = (response.body as Body<OwnReport>).data;
      expect(report.publicId).toMatch(/^CE-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(report).toMatchObject({
        status: 'SUBMITTED',
        routing: 'ROUTED',
        organizationName: 'Dhaka North City Corporation',
        canEdit: true,
        canWithdraw: true,
        version: 1,
      });
      expect(report.photos[0]?.displayUrl).toEqual(expect.any(String));

      const history = await citizen.get(`/reports/${report.publicId}/history`).expect(200);
      expect((history.body as Body<Array<{ toStatus: string }>>).data).toEqual([
        expect.objectContaining({ fromStatus: null, toStatus: 'SUBMITTED' }),
      ]);
    });

    it('sends reports outside every area, or inside several, to triage', async () => {
      const outside = (await submit(citizen, OUTSIDE_ALL)).body as Body<OwnReport>;
      const both = (await submit(citizen, IN_BOTH)).body as Body<OwnReport>;
      expect(outside.data.routing).toBe('UNROUTED');
      expect(both.data.routing).toBe('AMBIGUOUS');

      const admin = await h.superAdmin('triage-admin@example.test');
      const triage = await admin.get('/admin/reports/triage').expect(200);
      const items = (
        triage.body as Body<Array<{ publicId: string; candidates: Array<{ name: string }> }>>
      ).data;
      expect(items.map((item) => item.publicId)).toEqual(
        expect.arrayContaining([outside.data.publicId, both.data.publicId]),
      );
      expect(
        items
          .find((item) => item.publicId === both.data.publicId)
          ?.candidates.map((c) => c.name)
          .sort(),
      ).toEqual(['Dhaka North City Corporation', 'Dhaka South City Corporation']);

      await citizen.get('/admin/reports/triage').expect(403);
      await admin
        .post(`/admin/reports/${both.data.publicId}/route`, {
          organizationId: northId,
          reason: 'Ward 17 belongs to DNCC',
        })
        .expect(200);
      await admin
        .post(`/admin/reports/${both.data.publicId}/route`, {
          organizationId: northId,
          reason: 'Second attempt',
        })
        .expect(422);
      const after = await admin.get('/admin/reports/triage').expect(200);
      expect(
        (after.body as Body<Array<{ publicId: string }>>).data.map((i) => i.publicId),
      ).not.toContain(both.data.publicId);
      const decision = await h.prisma.reportRoutingDecision.findFirstOrThrow({
        where: { report: { publicId: both.data.publicId }, outcome: 'MANUAL' },
      });
      expect(decision.reason).toBe('Ward 17 belongs to DNCC');
    });

    it('creates exactly one report per Idempotency-Key', async () => {
      const { mediaId } = await uploadPhoto(citizen);
      const body = {
        title: 'Broken drain cover',
        description: 'The drain cover is broken and dangerous at night.',
        categoryId: potholeId,
        ...IN_NORTH_ONLY,
        mediaIds: [mediaId],
      };
      const key = randomUUID();
      const first = await citizen.post('/reports', body).set('Idempotency-Key', key).expect(201);
      const retry = await citizen.post('/reports', body).set('Idempotency-Key', key).expect(201);
      expect((retry.body as Body<OwnReport>).data.publicId).toBe(
        (first.body as Body<OwnReport>).data.publicId,
      );
      expect(await h.prisma.report.count({ where: { title: 'Broken drain cover' } })).toBe(1);

      await citizen
        .post('/reports', { ...body, title: 'Something different' })
        .set('Idempotency-Key', key)
        .expect(409);
      await citizen.post('/reports', body).expect(400); // No key at all.
    });

    it.each([
      ['no photos', { mediaIds: [] }],
      ['six photos', { mediaIds: Array.from({ length: 6 }, () => randomUUID()) }],
      ['a location outside Bangladesh', { latitude: 51.5, longitude: -0.12 }],
      ['a too-short title', { title: 'Hole' }],
      ['an unknown category', { categoryId: randomUUID() }],
    ])('rejects a report with %s', async (_label, overrides) => {
      await submit(citizen, overrides, 400);
    });

    it('only accepts the citizen’s own, processed, unused photos', async () => {
      const { client: other } = await h.signedIn('other-submit@example.test');
      const theirs = await uploadPhoto(other);
      const rejected = await uploadPhoto(citizen, Buffer.from('not an image '.repeat(40)));
      for (const mediaId of [theirs.mediaId, rejected.mediaId]) {
        const response = await submit(citizen, { mediaIds: [mediaId] }, 400);
        expect((response.body as Body).error?.details[0]?.field).toBe('mediaIds');
      }
      const used = (await submit(citizen)).body as Body<OwnReport>;
      await submit(citizen, { mediaIds: [used.data.photos[0]?.id] }, 400);
    });

    it('enforces the report rate limit', async () => {
      const userId = (
        await h.prisma.user.findUniqueOrThrow({ where: { email: 'citizen@example.test' } })
      ).id;
      const key = `civiceye:authlimit:reports:user:hour:${createHash('sha256').update(userId).digest('hex')}`;
      await h.redis.set(key, '10', 'EX', 3600);
      const response = await submit(citizen, {}, 429);
      expect((response.body as Body).error?.code).toBe('RATE_LIMITED');
    });
  });

  describe('visibility', () => {
    it('never shows the reporter or the exact location publicly', async () => {
      const own = (
        (await submit(citizen, { latitude: 23.861234, longitude: 90.371234 }))
          .body as Body<OwnReport>
      ).data;
      expect(own.latitude).toBe(23.861234);

      const anonymous = await h.client().get(`/reports/${own.publicId}`).expect(200);
      const publicView = (anonymous.body as Body<Record<string, unknown>>).data;
      expect(publicView).toMatchObject({ latitude: 23.861, longitude: 90.371, photoCount: 1 });
      const serialized = JSON.stringify(anonymous.body);
      for (const secret of [
        'citizen@example.test',
        'Rahima',
        'citizenId',
        'photos',
        'displayUrl',
        '23.861234',
      ]) {
        expect(serialized).not.toContain(secret);
      }
      const list = await h.client().get('/reports').expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/citizen@example\.test|Rahima|23\.861234/);
    });

    it('hides private reports from everyone but the citizen', async () => {
      const own = ((await submit(citizen, { visibility: 'PRIVATE' })).body as Body<OwnReport>).data;
      await citizen.get(`/reports/${own.publicId}`).expect(200);
      const { client: other } = await h.signedIn('other-viewer@example.test');
      await other.get(`/reports/${own.publicId}`).expect(404);
      await h.client().get(`/reports/${own.publicId}/history`).expect(404);
    });
  });

  describe('editing and withdrawing', () => {
    it('requires the current version and records every change', async () => {
      const own = ((await submit(citizen)).body as Body<OwnReport>).data;
      const path = `/reports/${own.publicId}`;

      await citizen.patch(path, { title: 'Pothole near the bus stop' }).expect(428);
      await citizen
        .patch(path, { title: 'Pothole near the bus stop' })
        .set('If-Match', '7')
        .expect(409);
      const edited = await citizen
        .patch(path, { title: 'Pothole near the bus stop' })
        .set('If-Match', '1')
        .expect(200);
      expect((edited.body as Body<OwnReport>).data.version).toBe(2);

      // Moving the report re-routes it.
      const moved = await citizen.patch(path, OUTSIDE_ALL).set('If-Match', '2').expect(200);
      expect((moved.body as Body<OwnReport>).data).toMatchObject({
        routing: 'UNROUTED',
        organizationName: null,
        version: 3,
      });

      const edits = await h.prisma.reportEdit.findMany({
        where: { report: { publicId: own.publicId } },
        orderBy: { version: 'asc' },
      });
      expect(edits.map((edit) => Object.keys(edit.changes as object))).toEqual([
        ['title'],
        ['location'],
      ]);
      await expect(
        h.prisma.reportEdit.update({ where: { id: edits[0]!.id }, data: { version: 99 } }),
      ).rejects.toThrow(/append-only/);

      const { client: other } = await h.signedIn('other-editor@example.test');
      await other.patch(path, { title: 'Hijacked title here' }).set('If-Match', '3').expect(404);
    });

    it('withdraws once, then blocks edits and public access', async () => {
      const own = ((await submit(citizen)).body as Body<OwnReport>).data;
      const path = `/reports/${own.publicId}`;

      await citizen.post(`${path}/withdraw`, { reason: 'x' }).expect(400);
      const withdrawn = await citizen
        .post(`${path}/withdraw`, { reason: 'Fixed by neighbours' })
        .expect(200);
      expect((withdrawn.body as Body<OwnReport>).data).toMatchObject({
        status: 'WITHDRAWN',
        canEdit: false,
        canWithdraw: false,
      });

      await citizen.post(`${path}/withdraw`, { reason: 'Again please' }).expect(422);
      await citizen
        .patch(path, { title: 'Too late to edit this' })
        .set('If-Match', '2')
        .expect(422);
      await h.client().get(path).expect(404);

      const history = await citizen.get(`${path}/history`).expect(200);
      expect(
        (history.body as Body<Array<{ toStatus: string; reason: string | null }>>).data.at(-1),
      ).toMatchObject({
        toStatus: 'WITHDRAWN',
        reason: 'Fixed by neighbours',
      });
      const entry = await h.prisma.reportStatusHistory.findFirstOrThrow({
        where: { report: { publicId: own.publicId } },
      });
      await expect(
        h.prisma.reportStatusHistory.delete({ where: { id: entry.id } }),
      ).rejects.toThrow(/append-only/);
    });

    it('summarizes the citizen’s reports by status', async () => {
      const summary = await citizen.get('/reports/mine/summary').expect(200);
      const data = (summary.body as Body<{ total: number; byStatus: Record<string, number> }>).data;
      expect(data.total).toBeGreaterThanOrEqual(5);
      expect(data.byStatus['WITHDRAWN']).toBeGreaterThanOrEqual(1);
      const mine = await citizen.get('/reports/mine?status=WITHDRAWN').expect(200);
      expect(
        (mine.body as Body<Array<{ status: string }>>).data.every((r) => r.status === 'WITHDRAWN'),
      ).toBe(true);
    });
  });
});
