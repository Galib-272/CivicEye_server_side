import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { AiService } from '../../src/modules/ai/ai.service';
import { startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = { data: T; error?: { code: string; message: string } };
type Prediction = {
  id: string;
  status: string;
  label: string | null;
  confidence: number | null;
  uncertain: boolean | null;
  modelVersion: string | null;
  detections: Array<{ box: number[]; score: number }>;
  warnings: string[];
  errorCode: string | null;
  suggestedCategories: Array<{ slug: string }>;
  review: { action: string; correctedLabel: string | null } | null;
};
type View = { enabled: boolean; predictions: Prediction[] };

/** The first item of a list the test expects to be non-empty. */
function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('Expected at least one item');
  return item;
}

const AREA = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const TOKEN = 'integration-test-token-0123456789abcdef';

/** A stand-in for the Python AI service: answers like it, and records what it received. */
function fakeAiService() {
  const state = {
    mode: 'ok' as 'ok' | 'garbage' | 'error',
    label: 'pothole',
    requests: [] as Array<{ authorization?: string; contentType?: string; bytes: number }>,
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', modelVersion: 'road-damage-test' }));
        return;
      }
      state.requests.push({
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        bytes: Buffer.concat(chunks).length,
      });
      if (state.mode === 'error') {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (state.mode === 'garbage') {
        res.end(JSON.stringify({ label: 'banana', confidence: 7 }));
        return;
      }
      res.end(
        JSON.stringify({
          modelVersion: 'road-damage-test',
          label: state.label,
          confidence: 0.91,
          uncertain: false,
          probabilities: { pothole: 0.91, crack: 0.04, asphalt_damage: 0.03, no_damage: 0.02 },
          damageProbability: 0.98,
          detections: [{ box: [0.1, 0.2, 0.5, 0.6], score: 0.88 }],
          quality: { brightness: 0.45, sharpness: 120.5, warnings: [] },
          timingsMs: { classification: 150, total: 190 },
        }),
      );
    });
  });
  return { server, state };
}

describe('Advisory AI (real PostGIS, Redis, storage; stand-in AI service)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let reviewer: Client;
  let otherReviewer: Client;
  let admin: Client;
  let organizationId: string;
  let otherOrganizationId: string;
  let potholeId: string;
  const ai = fakeAiService();

  async function verifiedOrganization(name: string) {
    const organization = await h.prisma.organization.create({
      data: {
        name,
        officialEmailDomain: `${randomUUID().slice(0, 8)}.gov.bd`,
        verificationState: 'VERIFIED',
      },
    });
    return organization.id;
  }

  async function reviewerOf(email: string, orgId: string) {
    const { client, userId } = await h.signedIn(email, 'Reviewer');
    await h.prisma.organizationMember.create({
      data: { organizationId: orgId, userId, role: 'ORG_REVIEWER', status: 'ACTIVE' },
    });
    return client;
  }

  async function uploadPhoto() {
    const content = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#556677' },
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

  async function submit(photos = 1) {
    const mediaIds = [];
    for (let i = 0; i < photos; i += 1) mediaIds.push(await uploadPhoto());
    const response = await citizen
      .post('/reports', {
        title: 'Deep pothole near the school gate',
        description: 'A deep pothole that fills with water when it rains.',
        categoryId: potholeId,
        latitude: 23.86,
        longitude: 90.37,
        visibility: 'PUBLIC',
        mediaIds,
      })
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return (response.body as Body<{ publicId: string }>).data.publicId;
  }

  const aiPath = (publicId: string, orgId = organizationId) =>
    `/organizations/${orgId}/reports/${publicId}/ai`;

  async function settled(publicId: string): Promise<View> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await reviewer.get(aiPath(publicId)).expect(200);
      const view = (response.body as Body<View>).data;
      if (view.predictions.length > 0 && view.predictions.every((p) => p.status !== 'PENDING')) {
        return view;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('AI analysis did not finish in time');
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => ai.server.listen(0, '127.0.0.1', resolve));
    const { port } = ai.server.address() as AddressInfo;
    h = await startAuthHarness([], {
      runWorkers: true,
      config: {
        ai: {
          enabled: true,
          serviceUrl: `http://127.0.0.1:${port}`,
          token: TOKEN,
          timeoutMs: 5000,
        },
      },
    });
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    ({ client: citizen } = await h.signedIn('citizen@example.test', 'Rahima Akter'));
    organizationId = await verifiedOrganization('Dhaka North');
    otherOrganizationId = await verifiedOrganization('Dhaka South');
    await h.prisma.$executeRaw`
      INSERT INTO service_areas (id, organization_id, name, geom, area_sq_km, point_count, created_by_id, updated_at)
      SELECT ${randomUUID()}::uuid, ${organizationId}::uuid, 'North',
             ST_Multi(ST_MakeEnvelope(${AREA.minLon}, ${AREA.minLat}, ${AREA.maxLon}, ${AREA.maxLat}, 4326)),
             100, 5, u.id, now()
      FROM users u LIMIT 1`;
    await h.prisma.organizationCategory.create({ data: { organizationId, categoryId: potholeId } });
    reviewer = await reviewerOf('reviewer@north.gov.bd', organizationId);
    otherReviewer = await reviewerOf('reviewer@south.gov.bd', otherOrganizationId);
    admin = await h.superAdmin('root@civiceye.test');
  });

  afterAll(async () => {
    await h?.close();
    await new Promise((resolve) => ai.server.close(resolve));
  });

  beforeEach(async () => {
    ai.state.mode = 'ok';
    ai.state.label = 'pothole';
    await h.resetRateLimits();
  });

  it('analyses every photo after submission and shows reviewers an advisory suggestion', async () => {
    const before = ai.state.requests.length;
    const publicId = await submit(2);
    const view = await settled(publicId);

    expect(view.enabled).toBe(true);
    expect(view.predictions).toHaveLength(2);
    const firstPrediction = first(view.predictions);
    expect(firstPrediction).toMatchObject({
      status: 'SUCCEEDED',
      label: 'pothole',
      confidence: expect.closeTo(0.91, 5),
      uncertain: false,
      modelVersion: 'road-damage-test',
      warnings: [],
      review: null,
    });
    expect(firstPrediction.detections).toEqual([{ box: [0.1, 0.2, 0.5, 0.6], score: 0.88 }]);
    expect(firstPrediction.suggestedCategories.map((c) => c.slug)).toEqual(['pothole']);

    // The backend sent the processed photo (no original, no metadata) with the shared token.
    const sent = ai.state.requests.slice(before);
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.contentType).toMatch(/^multipart\/form-data/);
      expect(request.bytes).toBeGreaterThan(1000);
    }

    // The AI never changes the report.
    const report = await h.prisma.report.findUniqueOrThrow({ where: { publicId } });
    expect(report.status).toBe('SUBMITTED');
    expect(report.categoryId).toBe(potholeId);
  });

  it('offers every crack category for a crack', async () => {
    ai.state.label = 'crack';
    const view = await settled(await submit());
    expect(first(view.predictions).suggestedCategories.map((c) => c.slug)).toEqual([
      'longitudinal-crack',
      'transverse-crack',
      'alligator-cracking',
    ]);
  });

  it('records a reviewer’s decision once, with an audit entry', async () => {
    const publicId = await submit();
    const prediction = first((await settled(publicId)).predictions);
    const reviewPath = `${aiPath(publicId)}/${prediction.id}/review`;

    // A correction must say what the photo shows.
    await reviewer.post(reviewPath, { action: 'CORRECTED' }).expect(400);
    await reviewer.post(reviewPath, { action: 'ACCEPTED', correctedLabel: 'crack' }).expect(400);

    const reviewed = await reviewer
      .post(reviewPath, { action: 'CORRECTED', correctedLabel: 'asphalt_damage' })
      .expect(200);
    expect(first((reviewed.body as Body<View>).data.predictions).review).toMatchObject({
      action: 'CORRECTED',
      correctedLabel: 'asphalt_damage',
    });
    await reviewer.post(reviewPath, { action: 'DISMISSED' }).expect(409);

    const audit = await h.prisma.auditLog.findFirst({
      where: { action: 'ai.prediction_reviewed', targetId: prediction.id },
    });
    expect(audit?.metadata).toMatchObject({
      action: 'CORRECTED',
      correctedLabel: 'asphalt_damage',
    });
  });

  it('shows suggestions only to reviewers of the handling organization and Super Admins', async () => {
    const publicId = await submit();
    const prediction = first((await settled(publicId)).predictions);

    await otherReviewer.get(aiPath(publicId, otherOrganizationId)).expect(404);
    await otherReviewer.get(aiPath(publicId)).expect(404);
    await citizen.get(aiPath(publicId)).expect(404);
    await otherReviewer
      .post(`${aiPath(publicId, otherOrganizationId)}/${prediction.id}/review`, {
        action: 'ACCEPTED',
      })
      .expect(404);

    const asAdmin = await admin.get(`/admin/reports/${publicId}/ai`).expect(200);
    expect((asAdmin.body as Body<View>).data.predictions).toHaveLength(1);
    await citizen.get(`/admin/reports/${publicId}/ai`).expect(403);

    const status = await admin.get('/admin/ai/status').expect(200);
    expect(
      (status.body as Body<{ enabled: boolean; serviceModelVersion: string }>).data,
    ).toMatchObject({ enabled: true, serviceModelVersion: 'road-damage-test' });
  });

  it('records an unexpected answer as failed, and the report is unaffected', async () => {
    ai.state.mode = 'garbage';
    const publicId = await submit();
    const prediction = first((await settled(publicId)).predictions);
    expect(prediction).toMatchObject({ status: 'FAILED', errorCode: 'bad_response', label: null });
    const report = await h.prisma.report.findUniqueOrThrow({ where: { publicId } });
    expect(report.status).toBe('SUBMITTED');
  });

  it('retries when the service is down, without affecting the report', async () => {
    ai.state.mode = 'error';
    const service = h.app.get(AiService);
    const { publicId } = await h.prisma.report.findFirstOrThrow({
      where: { publicId: await submit() },
      select: { publicId: true },
    });
    const pending = await h.prisma.aiPrediction.findFirstOrThrow({
      where: { report: { publicId } },
    });
    // The worker's first attempt fails and is retried later; a direct attempt fails the same way.
    await expect(service.process(pending.id)).rejects.toMatchObject({ code: 'server_error' });
    expect(
      (await h.prisma.aiPrediction.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('PENDING');

    ai.state.mode = 'ok';
    await service.process(pending.id);
    expect(
      (await h.prisma.aiPrediction.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('SUCCEEDED');
  });
});
