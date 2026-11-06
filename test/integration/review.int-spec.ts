import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = {
  data: T;
  error?: { code: string; message: string };
};

type WorkspaceReport = {
  publicId: string;
  status: string;
  version: number;
  routing: string;
  category: { id: string };
  photos: unknown[];
  informationRequests: Array<{ message: string; response: { photoCount: number } | null }>;
  rejection: { reason: string; message: string } | null;
  actions: Record<string, boolean>;
};

type OwnReport = {
  status: string;
  version: number;
  canProvideInformation: boolean;
  informationRequest: { message: string } | null;
  rejection: { reason: string; message: string } | null;
  photos: unknown[];
};

const NORTH = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const SOUTH = { minLon: 90.4, minLat: 23.7, maxLon: 90.5, maxLat: 23.82 }; // overlaps NORTH
const IN_NORTH_ONLY = { latitude: 23.86, longitude: 90.37 };
const IN_BOTH = { latitude: 23.8, longitude: 90.42 };

const NOTE = 'Internal: crew lead says this is the third report on this road.';

describe('Organization review workflow (real PostGIS, Redis and storage)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let citizenId: string;
  let northReviewer: Client;
  let northWorker: Client;
  let southReviewer: Client;
  let admin: Client;
  let anonymous: Client;
  let potholeId: string;
  let garbageId: string;
  let northId: string;
  let southId: string;

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

  async function member(
    email: string,
    organizationId: string,
    role: 'ORG_ADMIN' | 'ORG_REVIEWER' | 'WORKER',
  ) {
    const { client, userId } = await h.signedIn(email, `${role} ${email}`);
    await h.prisma.organizationMember.create({
      data: { organizationId, userId, role, status: 'ACTIVE' },
    });
    return client;
  }

  async function uploadPhoto(client: Client) {
    const content = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#556677' },
    })
      .jpeg()
      .toBuffer();
    const intent = await client
      .post('/media/upload-intent', { contentType: 'image/jpeg', byteSize: content.length })
      .expect(201);
    const { mediaId, uploadUrl } = (intent.body as Body<{ mediaId: string; uploadUrl: string }>)
      .data;
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: content,
    });
    expect(put.status).toBe(200);
    await client.post(`/media/${mediaId}/confirm`).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const view = await client.get(`/media/${mediaId}`).expect(200);
      if ((view.body as Body<{ status: string }>).data.status === 'PROCESSED') return mediaId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Photo was not processed in time');
  }

  async function submit(location = IN_NORTH_ONLY, visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
    const response = await citizen
      .post('/reports', {
        title: 'Deep pothole near the bus stop',
        description: 'A deep pothole that fills with water when it rains.',
        categoryId: potholeId,
        ...location,
        visibility,
        mediaIds: [await uploadPhoto(citizen)],
      })
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return (response.body as Body<{ publicId: string }>).data.publicId;
  }

  const base = (organizationId: string, publicId: string) =>
    `/organizations/${organizationId}/reports/${publicId}`;

  async function workspace(client: Client, organizationId: string, publicId: string) {
    const response = await client.get(base(organizationId, publicId)).expect(200);
    return (response.body as Body<WorkspaceReport>).data;
  }

  /** POSTs a review action with the current version as If-Match. */
  async function act(
    client: Client,
    organizationId: string,
    publicId: string,
    action: string,
    body: object = {},
    status = 200,
  ) {
    const { version } = await workspace(client, organizationId, publicId);
    return client
      .post(`${base(organizationId, publicId)}/${action}`, body)
      .set('If-Match', String(version))
      .expect(status);
  }

  async function own(publicId: string) {
    return ((await citizen.get(`/reports/${publicId}`).expect(200)).body as Body<OwnReport>).data;
  }

  beforeAll(async () => {
    h = await startAuthHarness([], { runWorkers: true });
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    garbageId = (
      await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'garbage-accumulation' } })
    ).id;
    ({ client: citizen, userId: citizenId } = await h.signedIn(
      'citizen@example.test',
      'Rahima Akter',
    ));
    northId = await verifiedOrganization('Dhaka North City Corporation', 'dncc.gov.bd', NORTH);
    southId = await verifiedOrganization('Dhaka South City Corporation', 'dscc.gov.bd', SOUTH);
    northReviewer = await member('reviewer@dncc.gov.bd', northId, 'ORG_REVIEWER');
    northWorker = await member('worker@dncc.gov.bd', northId, 'WORKER');
    southReviewer = await member('admin@dscc.gov.bd', southId, 'ORG_ADMIN');
    admin = await h.superAdmin('root@civiceye.test');
    anonymous = h.client();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
  });

  describe('access', () => {
    it('shows the queue only to reviewers of the handling organization', async () => {
      const publicId = await submit();

      const queue = await northReviewer.get(`/organizations/${northId}/reports`).expect(200);
      expect((queue.body as Body<Array<{ publicId: string }>>).data).toEqual(
        expect.arrayContaining([expect.objectContaining({ publicId })]),
      );
      const counts = await northReviewer
        .get(`/organizations/${northId}/reports/counts`)
        .expect(200);
      expect((counts.body as Body<Record<string, number>>).data['NEW']).toBeGreaterThan(0);

      // Another organization, a worker, the citizen and a Super Admin all get NOT_FOUND here.
      await southReviewer.get(`/organizations/${northId}/reports`).expect(404);
      await southReviewer.get(base(southId, publicId)).expect(404);
      await northWorker.get(`/organizations/${northId}/reports`).expect(404);
      await citizen.get(base(northId, publicId)).expect(404);
      await admin.get(base(northId, publicId)).expect(404);
      await anonymous.get(base(northId, publicId)).expect(401);
    });

    it('never shows the reporter to the organization', async () => {
      const publicId = await submit();
      const response = await northReviewer.get(base(northId, publicId)).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(citizenId);
      expect(text).not.toContain('citizen@example.test');
      expect(text).not.toContain('Rahima');
    });
  });

  describe('review decisions', () => {
    it('needs If-Match and refuses a stale version', async () => {
      const publicId = await submit();
      await northReviewer.post(`${base(northId, publicId)}/start-review`).expect(428);
      await northReviewer
        .post(`${base(northId, publicId)}/start-review`)
        .set('If-Match', '99')
        .expect(409);
    });

    it('requests information, takes the citizen’s answer, then accepts', async () => {
      const publicId = await submit();
      await act(northReviewer, northId, publicId, 'start-review');
      await act(northReviewer, northId, publicId, 'request-information', {
        message: 'Please add a photo showing how wide the pothole is.',
      });

      const waiting = await own(publicId);
      expect(waiting).toMatchObject({
        status: 'NEEDS_INFORMATION',
        canProvideInformation: true,
        informationRequest: { message: 'Please add a photo showing how wide the pothole is.' },
      });
      // The request is for the citizen only, not the public timeline.
      const publicHistory = await anonymous.get(`/reports/${publicId}/history`).expect(200);
      expect(JSON.stringify(publicHistory.body)).not.toContain('how wide');

      await citizen
        .post(`/reports/${publicId}/additional-information`, {
          message: 'It is about one metre wide; second photo attached.',
          mediaIds: [await uploadPhoto(citizen)],
        })
        .expect(200);
      expect(await own(publicId)).toMatchObject({
        status: 'UNDER_REVIEW',
        canProvideInformation: false,
        informationRequest: null,
      });
      // A second answer is refused.
      await citizen
        .post(`/reports/${publicId}/additional-information`, {
          message: 'Answering again should not work.',
        })
        .expect(422);

      const reviewed = await workspace(northReviewer, northId, publicId);
      expect(reviewed.photos).toHaveLength(2);
      expect(reviewed.informationRequests[0]?.response?.photoCount).toBe(1);

      await act(northReviewer, northId, publicId, 'accept', {
        publicMessage: 'Thank you, a repair crew will be scheduled.',
      });
      const accepted = await workspace(northReviewer, northId, publicId);
      expect(accepted.status).toBe('ACCEPTED');
      expect(accepted.actions).toMatchObject({ accept: false, reject: false, transfer: true });
      const history = await anonymous.get(`/reports/${publicId}/history`).expect(200);
      expect(JSON.stringify(history.body)).toContain('a repair crew will be scheduled');

      // Accepting twice is not a valid transition.
      await act(northReviewer, northId, publicId, 'accept', {}, 422);
    });

    it('rejects with a reason the citizen sees', async () => {
      const publicId = await submit();
      await act(northReviewer, northId, publicId, 'start-review');
      await act(northReviewer, northId, publicId, 'reject', {
        reason: 'ALREADY_FIXED',
        message: 'This pothole was filled last week during scheduled repairs.',
      });
      expect((await own(publicId)).rejection).toEqual({
        reason: 'ALREADY_FIXED',
        message: 'This pothole was filled last week during scheduled repairs.',
      });
      const decision = await h.prisma.reportReviewDecision.findFirstOrThrow({
        where: { report: { publicId } },
      });
      expect(decision).toMatchObject({ decision: 'REJECTED', rejectionReason: 'ALREADY_FIXED' });
      // Rejected reports go nowhere.
      await act(
        northReviewer,
        northId,
        publicId,
        'transfer',
        {
          toOrganizationId: null,
          reason: 'Trying to move a rejected report.',
        },
        422,
      );
    });

    it('accepts only categories the organization handles, allowing a correction', async () => {
      const publicId = await submit();
      await act(northReviewer, northId, publicId, 'start-review');
      const refused = await act(
        northReviewer,
        northId,
        publicId,
        'accept',
        { categoryId: garbageId },
        422,
      );
      expect((refused.body as Body).error?.code).toBe('ORGANIZATION_NOT_ELIGIBLE');

      await h.prisma.organizationCategory.create({
        data: { organizationId: northId, categoryId: garbageId },
      });
      await act(northReviewer, northId, publicId, 'accept', { categoryId: garbageId });
      expect((await workspace(northReviewer, northId, publicId)).category.id).toBe(garbageId);
      const decision = await h.prisma.reportReviewDecision.findFirstOrThrow({
        where: { report: { publicId }, decision: 'ACCEPTED' },
      });
      expect(decision).toMatchObject({ categoryFromId: potholeId, categoryToId: garbageId });
    });

    it('lets only one of two simultaneous decisions win', async () => {
      const publicId = await submit();
      await act(northReviewer, northId, publicId, 'start-review');
      const { version } = await workspace(northReviewer, northId, publicId);
      const results = await Promise.all([
        northReviewer
          .post(`${base(northId, publicId)}/accept`, {})
          .set('If-Match', String(version)),
        northReviewer
          .post(`${base(northId, publicId)}/reject`, {
            reason: 'OTHER',
            message: 'Rejected in a race with an acceptance.',
          })
          .set('If-Match', String(version)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    });
  });

  describe('transfers', () => {
    it('moves the report to another eligible organization, which restarts the review', async () => {
      // IN_BOTH is ambiguous, so a Super Admin routes it to North first.
      const publicId = await submit(IN_BOTH);
      await admin
        .post(`/admin/reports/${publicId}/route`, {
          organizationId: northId,
          reason: 'Ward map puts this road in DNCC.',
        })
        .expect(200);
      await act(northReviewer, northId, publicId, 'start-review');
      await northReviewer.post(`${base(northId, publicId)}/notes`, { body: NOTE }).expect(201);

      const targets = await northReviewer
        .get(`${base(northId, publicId)}/transfer-targets`)
        .expect(200);
      expect((targets.body as Body<Array<{ id: string }>>).data).toEqual([
        { id: southId, name: 'Dhaka South City Corporation' },
      ]);

      await act(northReviewer, northId, publicId, 'transfer', {
        toOrganizationId: southId,
        reason: 'The road belongs to the southern ward according to our survey.',
      });

      // North lost access; South starts at SUBMITTED and cannot see North's notes.
      await northReviewer.get(base(northId, publicId)).expect(404);
      await northReviewer.get(`${base(northId, publicId)}/notes`).expect(404);
      const moved = await workspace(southReviewer, southId, publicId);
      expect(moved).toMatchObject({ status: 'SUBMITTED', routing: 'TRANSFERRED' });
      const southNotes = await southReviewer.get(`${base(southId, publicId)}/notes`).expect(200);
      expect((southNotes.body as Body<unknown[]>).data).toEqual([]);

      // A Super Admin sees every organization's notes; the view is audited.
      const adminNotes = await admin.get(`/admin/reports/${publicId}/notes`).expect(200);
      expect(JSON.stringify(adminNotes.body)).toContain(NOTE);
      await admin.get(`/admin/reports/${publicId}`).expect(200);
      const audited = await h.prisma.auditLog.count({
        where: { action: 'report.viewed_by_admin' },
      });
      expect(audited).toBeGreaterThan(0);

      expect(await h.prisma.reportTransfer.count({ where: { report: { publicId } } })).toBe(1);
    });

    it('refuses organizations that do not cover the location, and can send back to triage', async () => {
      const publicId = await submit(IN_NORTH_ONLY);
      const refused = await act(
        northReviewer,
        northId,
        publicId,
        'transfer',
        { toOrganizationId: southId, reason: 'South does not cover this point at all.' },
        422,
      );
      expect((refused.body as Body).error?.code).toBe('ORGANIZATION_NOT_ELIGIBLE');

      await act(northReviewer, northId, publicId, 'transfer', {
        toOrganizationId: null,
        reason: 'This is a private road, not a city corporation road.',
      });
      const triage = await admin.get('/admin/reports/triage').expect(200);
      expect((triage.body as Body<Array<{ publicId: string; note: string | null }>>).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            publicId,
            note: 'This is a private road, not a city corporation road.',
          }),
        ]),
      );
    });
  });

  describe('internal notes and public updates', () => {
    it('never shows internal notes to the citizen or the public', async () => {
      const publicId = await submit();
      await northReviewer.post(`${base(northId, publicId)}/notes`, { body: NOTE }).expect(201);
      await act(northReviewer, northId, publicId, 'start-review');

      for (const path of [
        `/reports/${publicId}`,
        `/reports/${publicId}/history`,
        `/reports/${publicId}/updates`,
      ]) {
        expect(JSON.stringify((await citizen.get(path).expect(200)).body)).not.toContain(NOTE);
        expect(JSON.stringify((await anonymous.get(path).expect(200)).body)).not.toContain(NOTE);
      }
      await citizen.get(`${base(northId, publicId)}/notes`).expect(404);
    });

    it('shows public updates until a Super Admin hides one', async () => {
      const publicId = await submit();
      const posted = await northReviewer
        .post(`${base(northId, publicId)}/updates`, { body: 'Inspection planned for Thursday.' })
        .expect(201);
      const [update] = (posted.body as Body<Array<{ id: string }>>).data;

      const visible = await anonymous.get(`/reports/${publicId}/updates`).expect(200);
      expect(
        (visible.body as Body<Array<{ body: string; organizationName: string }>>).data,
      ).toEqual([
        expect.objectContaining({
          body: 'Inspection planned for Thursday.',
          organizationName: 'Dhaka North City Corporation',
        }),
      ]);

      await admin
        .post(`/admin/reports/updates/${update?.id}/hide`, {
          reason: 'Posted on the wrong report.',
        })
        .expect(200);
      await admin
        .post(`/admin/reports/updates/${update?.id}/hide`, { reason: 'Hiding twice.' })
        .expect(404);
      const after = await anonymous.get(`/reports/${publicId}/updates`).expect(200);
      expect((after.body as Body<unknown[]>).data).toEqual([]);
      const orgView = await northReviewer.get(`${base(northId, publicId)}/updates`).expect(200);
      expect((orgView.body as Body<Array<{ hidden: boolean }>>).data[0]?.hidden).toBe(true);
    });

    it('keeps updates of private reports away from the public', async () => {
      const publicId = await submit(IN_NORTH_ONLY, 'PRIVATE');
      await northReviewer
        .post(`${base(northId, publicId)}/updates`, { body: 'Seen by the reporter only.' })
        .expect(201);
      await anonymous.get(`/reports/${publicId}/updates`).expect(404);
      await citizen.get(`/reports/${publicId}/updates`).expect(200);
    });

    it('stores review records append-only in the database', async () => {
      const publicId = await submit();
      await northReviewer.post(`${base(northId, publicId)}/notes`, { body: NOTE }).expect(201);
      await northReviewer
        .post(`${base(northId, publicId)}/updates`, { body: 'Original text.' })
        .expect(201);
      const note = await h.prisma.reportInternalNote.findFirstOrThrow({
        where: { report: { publicId } },
      });
      await expect(
        h.prisma.reportInternalNote.update({ where: { id: note.id }, data: { body: 'changed' } }),
      ).rejects.toThrow(/append-only/);
      await expect(h.prisma.reportInternalNote.delete({ where: { id: note.id } })).rejects.toThrow(
        /append-only/,
      );
      const update = await h.prisma.reportPublicUpdate.findFirstOrThrow({
        where: { report: { publicId } },
      });
      await expect(
        h.prisma.reportPublicUpdate.update({ where: { id: update.id }, data: { body: 'edited' } }),
      ).rejects.toThrow(/only hiding/);
    });
  });
});
