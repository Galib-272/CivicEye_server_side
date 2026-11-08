import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = { data: T; error?: { code: string; message: string } };
type Duration = { count: number; medianHours: number | null; enoughData: boolean };

const AREA = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const INSIDE = { latitude: 23.86, longitude: 90.37 };
const HOUR = 3600 * 1000;

describe('Dashboards, moderation and audit views (real PostGIS)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let citizenId: string;
  let neighbour: Client;
  let neighbourId: string;
  let reviewer: Client;
  let orgAdmin: Client;
  let otherReviewer: Client;
  let worker: Client;
  let workerId: string;
  let reviewerId: string;
  let admin: Client;
  let organizationId: string;
  let otherOrganizationId: string;
  let potholeId: string;

  async function organization(name: string, withArea: boolean) {
    const org = await h.prisma.organization.create({
      data: {
        name,
        officialEmailDomain: `${randomUUID().slice(0, 8)}.gov.bd`,
        verificationState: 'VERIFIED',
      },
    });
    if (withArea) {
      await h.prisma.$executeRaw`
        INSERT INTO service_areas (id, organization_id, name, geom, area_sq_km, point_count, created_by_id, updated_at)
        SELECT ${randomUUID()}::uuid, ${org.id}::uuid, 'Ward 1',
               ST_Multi(ST_MakeEnvelope(${AREA.minLon}, ${AREA.minLat}, ${AREA.maxLon}, ${AREA.maxLat}, 4326)),
               100, 5, u.id, now()
        FROM users u LIMIT 1`;
      await h.prisma.organizationCategory.create({
        data: { organizationId: org.id, categoryId: potholeId },
      });
    }
    return org.id;
  }

  async function member(
    email: string,
    orgId: string,
    role: 'ORG_ADMIN' | 'ORG_REVIEWER' | 'WORKER',
  ) {
    const { client, userId } = await h.signedIn(email, email.split('@')[0]);
    await h.prisma.organizationMember.create({
      data: { organizationId: orgId, userId, role, status: 'ACTIVE' },
    });
    return { client, userId };
  }

  async function uploadPhoto(client: Client) {
    const content = await sharp({
      create: { width: 320, height: 240, channels: 3, background: '#445566' },
    })
      .jpeg()
      .toBuffer();
    const intent = await client
      .post('/media/upload-intent', { contentType: 'image/jpeg', byteSize: content.length })
      .expect(201);
    const { mediaId, uploadUrl } = (intent.body as Body<{ mediaId: string; uploadUrl: string }>)
      .data;
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: content,
    });
    await client.post(`/media/${mediaId}/confirm`).expect(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const view = await client.get(`/media/${mediaId}`).expect(200);
      if ((view.body as Body<{ status: string }>).data.status === 'PROCESSED') return mediaId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Photo was not processed in time');
  }

  async function submit(client: Client = citizen) {
    const response = await client
      .post('/reports', {
        title: 'Deep pothole near the school gate',
        description: 'A deep pothole that fills with water when it rains.',
        categoryId: potholeId,
        ...INSIDE,
        visibility: 'PUBLIC',
        mediaIds: [await uploadPhoto(client)],
      })
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    const publicId = (response.body as Body<{ publicId: string }>).data.publicId;
    return h.prisma.report.findUniqueOrThrow({ where: { publicId } });
  }

  beforeAll(async () => {
    h = await startAuthHarness([], { runWorkers: true });
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    ({ client: citizen, userId: citizenId } = await h.signedIn('rahima@example.test', 'Rahima'));
    ({ client: neighbour, userId: neighbourId } = await h.signedIn('karim@example.test', 'Karim'));
    organizationId = await organization('Dhaka North', true);
    otherOrganizationId = await organization('Dhaka South', false);
    ({ client: reviewer, userId: reviewerId } = await member(
      'reviewer@north.gov.bd',
      organizationId,
      'ORG_REVIEWER',
    ));
    ({ client: orgAdmin } = await member('admin@north.gov.bd', organizationId, 'ORG_ADMIN'));
    ({ client: otherReviewer } = await member(
      'reviewer@south.gov.bd',
      otherOrganizationId,
      'ORG_REVIEWER',
    ));
    ({ client: worker, userId: workerId } = await member(
      'worker@north.gov.bd',
      organizationId,
      'WORKER',
    ));
    admin = await h.superAdmin('root@civiceye.test');
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
  });

  describe('dashboards', () => {
    let resolvedId: string;

    beforeAll(async () => {
      // Three reports with known timestamps (reviews 2 h, 4 h and 6 h; one resolved after 30 h;
      // assignment 1 h after acceptance; work done in 3 h).
      const now = Date.now();
      const reports = [await submit(), await submit(), await submit()];
      const [a, b, c] = reports as [(typeof reports)[0], (typeof reports)[0], (typeof reports)[0]];
      resolvedId = a.id;
      const submittedAt = new Date(now - 40 * HOUR);
      for (const report of reports) {
        await h.prisma.report.update({ where: { id: report.id }, data: { submittedAt } });
      }
      const at = (hours: number) => new Date(submittedAt.getTime() + hours * HOUR);
      const decide = (reportId: string, decision: 'ACCEPTED' | 'REJECTED', hours: number) =>
        h.prisma.reportReviewDecision.create({
          data: {
            reportId,
            organizationId,
            reviewerId,
            decision,
            rejectionReason: decision === 'REJECTED' ? 'NOT_A_CIVIC_ISSUE' : null,
            publicMessage: decision === 'REJECTED' ? 'Not a road problem.' : null,
            createdAt: at(hours),
          },
        });
      await decide(a.id, 'ACCEPTED', 2);
      await decide(b.id, 'ACCEPTED', 4);
      await decide(c.id, 'REJECTED', 6);
      await h.prisma.reportStatusHistory.createMany({
        data: [
          {
            reportId: a.id,
            fromStatus: 'UNDER_REVIEW',
            toStatus: 'ACCEPTED',
            actorContext: 'reviewer',
            createdAt: at(2),
          },
          {
            reportId: a.id,
            fromStatus: 'PENDING_VERIFICATION',
            toStatus: 'RESOLVED',
            actorContext: 'reviewer',
            createdAt: at(30),
          },
        ],
      });
      await h.prisma.reportAssignment.create({
        data: {
          reportId: a.id,
          organizationId,
          workerId,
          assignedById: reviewerId,
          state: 'VERIFIED',
          assignedAt: at(3),
          acceptedAt: at(4),
          startedAt: at(5),
          completedAt: at(8),
          endedAt: at(30),
        },
      });
      await h.prisma.reportAssignment.create({
        data: {
          reportId: b.id,
          organizationId,
          workerId,
          assignedById: reviewerId,
          state: 'PENDING',
          assignedAt: new Date(now - 72 * HOUR),
        },
      });
      await h.prisma.report.update({ where: { id: a.id }, data: { status: 'RESOLVED' } });
      await h.prisma.report.update({ where: { id: b.id }, data: { status: 'ASSIGNED' } });
      await h.prisma.report.update({ where: { id: c.id }, data: { status: 'REJECTED' } });
    });

    it('computes the organization dashboard exactly', async () => {
      const response = await reviewer.get(`/organizations/${organizationId}/analytics`).expect(200);
      const data = (
        response.body as Body<{
          volume: Record<string, number>;
          backlog: Record<string, number>;
          times: Record<string, Duration>;
          workers: Array<{ userId: string; pending: number; verifiedInRange: number }>;
          categories: Array<{ id: string; count: number }>;
          areas: Array<{ name: string; count: number }>;
          trend: Array<{ received: number; resolved: number }>;
        }>
      ).data;
      expect(data.volume).toEqual({ received: 3, accepted: 2, rejected: 1, resolved: 1 });
      expect(data.backlog).toMatchObject({ inProgress: 1, awaitingReview: 0 });
      expect(data.times.review).toMatchObject({ count: 3, medianHours: 4, enoughData: false });
      expect(data.times.resolution).toMatchObject({ count: 1, medianHours: 30 });
      expect(data.times.assignment).toMatchObject({ count: 1, medianHours: 1 });
      expect(data.times.completion).toMatchObject({ count: 1, medianHours: 3 });
      expect(data.workers).toEqual([
        expect.objectContaining({ userId: workerId, pending: 1, verifiedInRange: 1 }),
      ]);
      expect(data.categories).toEqual([expect.objectContaining({ id: potholeId, count: 3 })]);
      expect(data.areas).toEqual([expect.objectContaining({ name: 'Ward 1', count: 3 })]);
      expect(data.trend).toHaveLength(12);
      expect(data.trend.reduce((sum, week) => sum + week.received, 0)).toBe(3);
    });

    it('limits each dashboard to its own scope', async () => {
      await otherReviewer.get(`/organizations/${organizationId}/analytics`).expect(404);
      await worker.get(`/organizations/${organizationId}/analytics`).expect(404);
      await citizen.get('/admin/analytics').expect(403);
      await reviewer
        .get(`/organizations/${organizationId}/analytics?from=2025-01-01&to=2026-11-08`)
        .expect(400);

      const own = await citizen.get('/users/me/dashboard').expect(200);
      expect((own.body as Body<{ total: number; resolved: number }>).data).toMatchObject({
        total: 3,
        resolved: 1,
      });
      const nobody = await neighbour.get('/users/me/dashboard').expect(200);
      expect((nobody.body as Body<{ total: number }>).data.total).toBe(0);

      const tasks = await worker.get('/users/me/work-dashboard').expect(200);
      expect((tasks.body as Body<Record<string, number>>).data).toMatchObject({
        pending: 1,
        completedTotal: 1,
        overdue: 1,
      });
      const noTasks = await reviewer.get('/users/me/work-dashboard').expect(200);
      expect((noTasks.body as Body<{ pending: number }>).data.pending).toBe(0);
    });

    it('gives Super Admins the platform view', async () => {
      const response = await admin.get('/admin/analytics').expect(200);
      const data = (
        response.body as Body<{
          reports: { submittedInRange: number };
          organizationPerformance: Array<{
            organizationId: string;
            received: number;
            resolved: number;
          }>;
          activity: unknown[];
        }>
      ).data;
      expect(data.reports.submittedInRange).toBeGreaterThanOrEqual(3);
      expect(data.organizationPerformance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ organizationId, received: 3, resolved: 1 }),
        ]),
      );
      expect(data.activity).toHaveLength(12);
      expect(resolvedId).toBeDefined();
    });
  });

  describe('moderation', () => {
    async function openCase(publicId: string) {
      const list = await admin.get('/admin/moderation/cases').expect(200);
      const cases = (
        list.body as Body<
          Array<{ id: string; report: { publicId: string }; flagCount: number; escalated: boolean }>
        >
      ).data;
      return cases.find((item) => item.report.publicId === publicId);
    }

    const act = (caseId: string, body: Record<string, unknown>, status = 200) =>
      admin.post(`/admin/moderation/cases/${caseId}/actions`, body).expect(status);

    it('collects flags into one case and lets a Super Admin decide, with notices', async () => {
      const report = await submit();
      const path = `/reports/${report.publicId}/flags`;

      await citizen.post(path, { reason: 'SPAM_OR_FAKE' }).expect(400); // own report
      await neighbour.post(path, { reason: 'OTHER' }).expect(400); // OTHER needs details
      await neighbour
        .post(path, { reason: 'PERSONAL_INFORMATION', details: 'Faces are visible.' })
        .expect(201);
      await neighbour.post(path, { reason: 'OFFENSIVE' }).expect(409);
      await reviewer
        .post(`/organizations/${organizationId}/reports/${report.publicId}/escalate`, {
          reason: 'MISLEADING_PHOTO',
          details: 'The photo is from another district.',
        })
        .expect(201);

      const listed = await openCase(report.publicId);
      expect(listed).toMatchObject({ flagCount: 2, escalated: true });
      const caseId = listed!.id;

      const detail = await admin.get(`/admin/moderation/cases/${caseId}`).expect(200);
      expect(
        (detail.body as Body<{ allowedActions: string[]; flags: unknown[] }>).data,
      ).toMatchObject({
        allowedActions: expect.arrayContaining(['START_REVIEW', 'HIDE_REPORT', 'SUSPEND_USER']),
        flags: [
          expect.objectContaining({ source: 'user', reporterName: 'Karim' }),
          expect.objectContaining({ source: 'organization', organizationName: 'Dhaka North' }),
        ],
      });

      // Every action needs a reason; warnings and correction requests need a message.
      await act(caseId, { kind: 'HIDE_REPORT' }, 400);
      await act(caseId, { kind: 'WARN_USER', reason: 'Faces visible in the photo.' }, 400);

      await act(caseId, { kind: 'HIDE_REPORT', reason: 'Faces are visible in the photo.' });
      await h.client().get(`/reports/${report.publicId}`).expect(404);
      const publicList = await h.client().get('/reports?limit=50').expect(200);
      expect(
        (publicList.body as Body<Array<{ publicId: string }>>).data.map((r) => r.publicId),
      ).not.toContain(report.publicId);
      await neighbour.post(path, { reason: 'SPAM_OR_FAKE' }).expect(404);

      await act(caseId, {
        kind: 'REQUEST_CORRECTION',
        reason: 'Photo shows faces.',
        message: 'Please submit the report again with a photo that does not show people’s faces.',
      });
      const own = await citizen.get(`/reports/${report.publicId}`).expect(200);
      const moderation = (
        own.body as Body<{
          moderation: {
            hiddenFromPublic: boolean;
            notices: Array<{ kind: string; message: string | null }>;
          };
        }>
      ).data.moderation;
      expect(moderation.hiddenFromPublic).toBe(true);
      expect(moderation.notices.map((n) => n.kind)).toEqual(['REQUEST_CORRECTION', 'HIDE_REPORT']);

      const stateNow = await admin.get(`/admin/moderation/cases/${caseId}`).expect(200);
      expect((stateNow.body as Body<{ status: string }>).data.status).toBe('ACTION_REQUIRED');

      // The citizen is notified (through the outbox).
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const count = await h.prisma.notification.count({
          where: {
            recipientId: citizenId,
            type: { in: ['REPORT_HIDDEN', 'CORRECTION_REQUESTED'] },
          },
        });
        if (count === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(
        await h.prisma.notification.count({
          where: {
            recipientId: citizenId,
            type: { in: ['REPORT_HIDDEN', 'CORRECTION_REQUESTED'] },
          },
        }),
      ).toBe(2);

      await act(caseId, { kind: 'RESOLVE', reason: 'Hidden until corrected.' });
      await act(
        caseId,
        { kind: 'WARN_USER', reason: 'Too late to warn.', message: 'Too late now.' },
        409,
      );
      // A mistake can still be undone after closing.
      await act(caseId, { kind: 'RESTORE_REPORT', reason: 'The faces were blurred after all.' });
      await h.client().get(`/reports/${report.publicId}`).expect(200);

      // A new flag after closing opens a new case.
      await h.resetRateLimits();
      const { client: third } = await h.signedIn('third@example.test', 'Third');
      await third.post(path, { reason: 'SPAM_OR_FAKE' }).expect(201);
      const reopened = await openCase(report.publicId);
      expect(reopened?.id).not.toBe(caseId);

      const audit = await admin.get('/admin/audit?action=moderation.hide_report').expect(200);
      expect((audit.body as Body<Array<{ targetId: string; reason: string }>>).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetId: caseId, reason: 'Faces are visible in the photo.' }),
        ]),
      );
    });

    it('suspends an account only by a moderator’s decision, and ends its sessions', async () => {
      const { client: spammer, userId: spammerId } = await h.signedIn('spam@example.test', 'Spam');
      const report = await submit(spammer);
      await neighbour
        .post(`/reports/${report.publicId}/flags`, { reason: 'SPAM_OR_FAKE' })
        .expect(201);
      // Flags alone change nothing.
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: spammerId } })).status).toBe(
        'ACTIVE',
      );

      const caseId = (await openCase(report.publicId))!.id;
      await act(caseId, { kind: 'SUSPEND_USER', reason: 'Repeated fake reports.' });
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: spammerId } })).status).toBe(
        'SUSPENDED',
      );
      await spammer.get('/users/me/dashboard').expect(401);
      const after = await admin.get(`/admin/moderation/cases/${caseId}`).expect(200);
      expect((after.body as Body<{ allowedActions: string[] }>).data.allowedActions).not.toContain(
        'SUSPEND_USER',
      );
    });

    it('moderates an organization’s public update', async () => {
      const report = await submit();
      const update = await h.prisma.reportPublicUpdate.create({
        data: { reportId: report.id, organizationId, authorId: reviewerId, body: 'Rude message.' },
      });
      await neighbour
        .post(`/reports/${report.publicId}/updates/${update.id}/flags`, { reason: 'OFFENSIVE' })
        .expect(201);
      const list = await admin.get('/admin/moderation/cases').expect(200);
      const item = (
        list.body as Body<Array<{ id: string; targetType: string; report: { publicId: string } }>>
      ).data.find((c) => c.targetType === 'PUBLIC_UPDATE' && c.report.publicId === report.publicId);
      const detail = await admin.get(`/admin/moderation/cases/${item!.id}`).expect(200);
      expect((detail.body as Body<{ allowedActions: string[] }>).data.allowedActions).toEqual([
        'START_REVIEW',
        'HIDE_UPDATE',
        'RESOLVE',
        'DISMISS',
      ]);
      await act(item!.id, { kind: 'HIDE_UPDATE', reason: 'Insulting language.' });
      expect(
        (await h.prisma.reportPublicUpdate.findUniqueOrThrow({ where: { id: update.id } }))
          .hiddenAt,
      ).not.toBeNull();
    });

    it('shows moderation workload on the platform dashboard', async () => {
      const response = await admin.get('/admin/analytics').expect(200);
      const data = (
        response.body as Body<{
          moderation: { byStatus: Record<string, number>; flagsInRange: number };
        }>
      ).data;
      expect(data.moderation.flagsInRange).toBeGreaterThanOrEqual(5);
      expect(
        Object.values(data.moderation.byStatus).reduce((a, b) => a + b, 0),
      ).toBeGreaterThanOrEqual(4);
    });
  });

  describe('audit views', () => {
    it('shows an organization only its own history, to its admins', async () => {
      await orgAdmin.get(`/organizations/${otherOrganizationId}/audit`).expect(404);
      await reviewer.get(`/organizations/${organizationId}/audit`).expect(404);
      await orgAdmin
        .patch(`/organizations/${organizationId}`, {
          description: 'Roads and drains of the north.',
        })
        .expect(200);
      const response = await orgAdmin
        .get(`/organizations/${organizationId}/audit?limit=100`)
        .expect(200);
      const entries = (response.body as Body<Array<{ action: string; ipAddress?: string }>>).data;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.ipAddress === undefined)).toBe(true);
      expect(entries.map((entry) => entry.action)).toContain('organization.updated');
      expect(entries.map((entry) => entry.action)).not.toContain('moderation.flagged');
    });

    it('lets Super Admins filter the whole log', async () => {
      const actions = await admin.get('/admin/audit/actions').expect(200);
      expect((actions.body as Body<string[]>).data).toEqual(
        expect.arrayContaining(['report.submitted', 'moderation.flagged']),
      );
      const byActor = await admin.get(`/admin/audit?actorId=${neighbourId}&limit=100`).expect(200);
      const data = (byActor.body as Body<Array<{ actor: { id: string } }>>).data;
      expect(data.length).toBeGreaterThan(0);
      expect(data.every((entry) => entry.actor.id === neighbourId)).toBe(true);
      await citizen.get('/admin/audit').expect(403);
    });
  });
});
