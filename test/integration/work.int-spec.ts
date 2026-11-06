import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = { data: T; error?: { code: string; message: string } };

type Workspace = {
  status: string;
  version: number;
  assignments: Array<{
    id: string;
    workerId: string;
    state: string;
    events: Array<{ kind: string; photos: unknown[] }>;
    submissions: Array<{ photos: unknown[]; verification: { outcome: string } | null }>;
  }>;
  feedback: Array<{ fixed: boolean }>;
  actions: Record<string, boolean>;
};

type Task = {
  assignment: { id: string; state: string };
  report: { publicId: string; status: string; photos: unknown[] };
  actions: Record<string, boolean>;
};

type OwnReport = {
  status: string;
  completion: { description: string; photos: unknown[] } | null;
  canGiveFeedback: boolean;
  feedback: { fixed: boolean } | null;
};

const AREA = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const POINT = { latitude: 23.86, longitude: 90.37 };

describe('Assignments, work and verification (real PostGIS, Redis and storage)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let reviewer: Client;
  let reviewerId: string;
  let worker: Client;
  let workerId: string;
  let worker2: Client;
  let worker2Id: string;
  let outsider: Client;
  let organizationId: string;
  let potholeId: string;

  async function member(email: string, role: 'ORG_REVIEWER' | 'WORKER') {
    const { client, userId } = await h.signedIn(email, `${role} ${email}`);
    await h.prisma.organizationMember.create({
      data: { organizationId, userId, role, status: 'ACTIVE' },
    });
    return { client, userId };
  }

  async function uploadPhoto(client: Client, purpose: 'REPORT_PHOTO' | 'WORK_PHOTO') {
    const content = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#557766' },
    })
      .jpeg()
      .toBuffer();
    const intent = await client
      .post('/media/upload-intent', {
        contentType: 'image/jpeg',
        byteSize: content.length,
        purpose,
      })
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

  const base = (publicId: string) => `/organizations/${organizationId}/reports/${publicId}`;

  async function workspace(publicId: string) {
    return ((await reviewer.get(base(publicId)).expect(200)).body as Body<Workspace>).data;
  }

  /** Organization action with the current version as If-Match. */
  async function orgAct(publicId: string, action: string, body: object = {}, status = 200) {
    const { version } = await workspace(publicId);
    return reviewer
      .post(`/organizations/${organizationId}/reports/${publicId}/${action}`, body)
      .set('If-Match', String(version))
      .expect(status);
  }

  /** A submitted report taken through review to ACCEPTED. */
  async function acceptedReport() {
    const response = await citizen
      .post('/reports', {
        title: 'Deep pothole near the bus stop',
        description: 'A deep pothole that fills with water when it rains.',
        categoryId: potholeId,
        ...POINT,
        mediaIds: [await uploadPhoto(citizen, 'REPORT_PHOTO')],
      })
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    const { publicId } = (response.body as Body<{ publicId: string }>).data;
    await orgAct(publicId, 'start-review');
    await orgAct(publicId, 'accept');
    return publicId;
  }

  async function assignedTo(publicId: string, userId: string) {
    await orgAct(publicId, 'assign', { workerId: userId, note: 'Bring cones.' });
    const assignment = (await workspace(publicId)).assignments.at(-1);
    if (!assignment) throw new Error('No assignment');
    return assignment.id;
  }

  async function task(client: Client, assignmentId: string, status = 200) {
    const response = await client.get(`/work/tasks/${assignmentId}`).expect(status);
    return (response.body as Body<Task>).data;
  }

  async function own(publicId: string) {
    return ((await citizen.get(`/reports/${publicId}`).expect(200)).body as Body<OwnReport>).data;
  }

  /** Takes an assigned task through accept, start and completion with one after photo. */
  async function workThrough(client: Client, assignmentId: string) {
    await client.post(`/work/tasks/${assignmentId}/accept`).expect(200);
    await client.post(`/work/tasks/${assignmentId}/start`).expect(200);
    await client
      .post(`/work/tasks/${assignmentId}/complete`, {
        description: 'Filled and compacted the pothole with asphalt.',
        mediaIds: [await uploadPhoto(client, 'WORK_PHOTO')],
      })
      .expect(200);
  }

  beforeAll(async () => {
    h = await startAuthHarness([], { runWorkers: true });
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    ({ client: citizen } = await h.signedIn('citizen@example.test', 'Rahima Akter'));
    const organization = await h.prisma.organization.create({
      data: {
        name: 'Dhaka North City Corporation',
        officialEmailDomain: 'dncc.gov.bd',
        verificationState: 'VERIFIED',
      },
    });
    organizationId = organization.id;
    await h.prisma.$executeRaw`
      INSERT INTO service_areas (id, organization_id, name, geom, area_sq_km, point_count, created_by_id, updated_at)
      SELECT ${randomUUID()}::uuid, ${organizationId}::uuid, 'North',
             ST_Multi(ST_MakeEnvelope(${AREA.minLon}, ${AREA.minLat}, ${AREA.maxLon}, ${AREA.maxLat}, 4326)),
             100, 5, u.id, now()
      FROM users u LIMIT 1`;
    await h.prisma.organizationCategory.create({ data: { organizationId, categoryId: potholeId } });
    ({ client: reviewer, userId: reviewerId } = await member(
      'reviewer@dncc.gov.bd',
      'ORG_REVIEWER',
    ));
    ({ client: worker, userId: workerId } = await member('worker@dncc.gov.bd', 'WORKER'));
    ({ client: worker2, userId: worker2Id } = await member('worker2@dncc.gov.bd', 'WORKER'));
    ({ client: outsider } = await h.signedIn('outsider@example.test'));
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
  });

  it('takes a report from accepted to closed, with evidence and verification', async () => {
    const publicId = await acceptedReport();
    const workers = await reviewer.get(`/organizations/${organizationId}/workers`).expect(200);
    expect((workers.body as Body<Array<{ userId: string; available: boolean }>>).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: workerId, available: true })]),
    );

    const assignmentId = await assignedTo(publicId, workerId);
    expect((await workspace(publicId)).status).toBe('ASSIGNED');

    // The worker sees the task and its location, never the reporter.
    const pending = await task(worker, assignmentId);
    expect(pending.actions).toMatchObject({ accept: true, start: false, complete: false });
    expect(pending.report.photos).toHaveLength(1);
    const raw = JSON.stringify((await worker.get(`/work/tasks/${assignmentId}`)).body);
    expect(raw).not.toContain('Rahima');
    expect(raw).not.toContain('citizen@example.test');

    await worker.post(`/work/tasks/${assignmentId}/start`).expect(422); // must accept first
    await worker.post(`/work/tasks/${assignmentId}/accept`).expect(200);
    await worker.post(`/work/tasks/${assignmentId}/start`).expect(200);
    expect((await workspace(publicId)).status).toBe('IN_PROGRESS');

    await worker
      .post(`/work/tasks/${assignmentId}/progress`, {
        message: 'Area cordoned off, waiting for asphalt.',
        mediaIds: [await uploadPhoto(worker, 'WORK_PHOTO')],
      })
      .expect(200);
    // Completion needs at least one after photo.
    await worker
      .post(`/work/tasks/${assignmentId}/complete`, {
        description: 'Filled the pothole.',
        mediaIds: [],
      })
      .expect(400);
    await worker
      .post(`/work/tasks/${assignmentId}/complete`, {
        description: 'Filled and compacted the pothole with asphalt.',
        mediaIds: [await uploadPhoto(worker, 'WORK_PHOTO')],
      })
      .expect(200);

    const pendingVerification = await workspace(publicId);
    expect(pendingVerification.status).toBe('PENDING_VERIFICATION');
    expect(pendingVerification.actions.verify).toBe(true);
    const history = await reviewer.get(`${base(publicId)}/history`).expect(200);
    const statuses = (history.body as Body<Array<{ toStatus: string }>>).data.map(
      (entry) => entry.toStatus,
    );
    expect(statuses).toEqual(expect.arrayContaining(['WORK_COMPLETED', 'PENDING_VERIFICATION']));

    // Needs more evidence → back to the same worker.
    await orgAct(publicId, 'verify', { outcome: 'NEEDS_MORE_EVIDENCE' }, 400); // reason required
    await orgAct(publicId, 'verify', {
      outcome: 'NEEDS_MORE_EVIDENCE',
      reason: 'Please add a photo from the street level.',
    });
    expect((await workspace(publicId)).status).toBe('IN_PROGRESS');
    expect((await task(worker, assignmentId)).actions.complete).toBe(true);

    await worker
      .post(`/work/tasks/${assignmentId}/complete`, {
        description: 'Street-level photo added; surface is level now.',
        mediaIds: [await uploadPhoto(worker, 'WORK_PHOTO')],
      })
      .expect(200);
    await orgAct(publicId, 'verify', { outcome: 'APPROVED' });

    const resolved = await workspace(publicId);
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.assignments[0]?.state).toBe('VERIFIED');
    expect(resolved.assignments[0]?.submissions.map((s) => s.verification?.outcome)).toEqual([
      'NEEDS_MORE_EVIDENCE',
      'APPROVED',
    ]);

    // The citizen sees the verified fix and answers "Is it fixed?" once.
    const fixed = await own(publicId);
    expect(fixed.completion?.photos).toHaveLength(1);
    expect(fixed.canGiveFeedback).toBe(true);
    await citizen
      .post(`/reports/${publicId}/feedback`, { fixed: false, comment: 'Water still pools.' })
      .expect(200);
    await citizen.post(`/reports/${publicId}/feedback`, { fixed: true }).expect(409);
    expect((await own(publicId)).status).toBe('RESOLVED'); // feedback never changes the status
    expect((await workspace(publicId)).feedback).toEqual([
      expect.objectContaining({ fixed: false }),
    ]);

    // Reopen, assign again, and finally close.
    await orgAct(publicId, 'reopen', { reason: 'The citizen says water still pools there.' });
    expect((await own(publicId)).completion).toBeNull();
    const second = await assignedTo(publicId, worker2Id);
    await workThrough(worker2, second);
    await orgAct(publicId, 'verify', { outcome: 'APPROVED' });
    await orgAct(publicId, 'close');
    expect((await own(publicId)).status).toBe('CLOSED');
  });

  it('never lets someone verify their own work', async () => {
    const publicId = await acceptedReport();
    // A reviewer who is assigned the work (e.g. as a former worker) still cannot verify it.
    await h.prisma.organizationMember.updateMany({
      where: { organizationId, userId: reviewerId },
      data: { role: 'WORKER' },
    });
    const assignmentId = await (async () => {
      // A second reviewer assigns the task to the first one.
      const { client: lead } = await member(`lead-${randomUUID()}@dncc.gov.bd`, 'ORG_REVIEWER');
      const { version } = ((await lead.get(base(publicId)).expect(200)).body as Body<Workspace>)
        .data;
      await lead
        .post(`${base(publicId)}/assign`, { workerId: reviewerId })
        .set('If-Match', String(version))
        .expect(200);
      return ((await lead.get(base(publicId)).expect(200)).body as Body<Workspace>).data
        .assignments[0]?.id as string;
    })();
    await workThrough(reviewer, assignmentId);
    await h.prisma.organizationMember.updateMany({
      where: { organizationId, userId: reviewerId },
      data: { role: 'ORG_REVIEWER' },
    });
    const refused = await orgAct(publicId, 'verify', { outcome: 'APPROVED' }, 403);
    expect((refused.body as Body).error?.message).toMatch(/your own work/);
  });

  it('handles decline, return, reassignment and cancellation', async () => {
    const publicId = await acceptedReport();
    const first = await assignedTo(publicId, workerId);
    await worker.post(`/work/tasks/${first}/decline`, { reason: 'Too short' }).expect(400);
    await worker
      .post(`/work/tasks/${first}/decline`, { reason: 'I am on leave this week.' })
      .expect(200);
    expect((await workspace(publicId)).status).toBe('ACCEPTED');

    const second = await assignedTo(publicId, workerId);
    await worker.post(`/work/tasks/${second}/accept`).expect(200);
    await worker.post(`/work/tasks/${second}/start`).expect(200);
    await worker
      .post(`/work/tasks/${second}/return`, { reason: 'Unsafe: live electric cable nearby.' })
      .expect(200);
    expect((await workspace(publicId)).status).toBe('ACCEPTED');

    const third = await assignedTo(publicId, workerId);
    await orgAct(publicId, 'reassign', { workerId, reason: 'Same worker again.' }, 400);
    await orgAct(publicId, 'reassign', {
      workerId: worker2Id,
      reason: 'Second crew is closer to the site.',
    });
    await task(worker, third); // still visible in their history
    const reassigned = await workspace(publicId);
    expect(reassigned.assignments.map((assignment) => assignment.state)).toEqual([
      'DECLINED',
      'RETURNED',
      'CANCELLED',
      'PENDING',
    ]);
    await orgAct(publicId, 'cancel-assignment', { reason: 'Road works postponed by the city.' });
    expect((await workspace(publicId)).status).toBe('ACCEPTED');
  });

  it('refuses unavailable workers and simultaneous double assignment', async () => {
    const publicId = await acceptedReport();
    await worker
      .put(`/work/memberships/${organizationId}/availability`, { available: false })
      .expect(200);
    await orgAct(publicId, 'assign', { workerId }, 400);
    await worker
      .put(`/work/memberships/${organizationId}/availability`, { available: true })
      .expect(200);

    const { version } = await workspace(publicId);
    const results = await Promise.all(
      [workerId, worker2Id].map((id) =>
        reviewer
          .post(`${base(publicId)}/assign`, { workerId: id })
          .set('If-Match', String(version)),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await workspace(publicId)).assignments).toHaveLength(1);
  });

  it('keeps tasks private to their worker and organization', async () => {
    const publicId = await acceptedReport();
    const assignmentId = await assignedTo(publicId, workerId);
    await task(worker2, assignmentId, 404);
    await task(outsider, assignmentId, 404);
    await worker2.post(`/work/tasks/${assignmentId}/accept`).expect(404);
    // Workers cannot assign or verify.
    await worker.get(`/organizations/${organizationId}/workers`).expect(404);
    await worker
      .post(`${base(publicId)}/verify`, { outcome: 'APPROVED' })
      .set('If-Match', '1')
      .expect(404);
    // Work photos are not report photos and vice versa.
    const workPhoto = await uploadPhoto(citizen, 'WORK_PHOTO');
    await citizen
      .post('/reports', {
        title: 'Using a work photo as a report photo',
        description: 'This should be refused by the server.',
        categoryId: potholeId,
        ...POINT,
        mediaIds: [workPhoto],
      })
      .set('Idempotency-Key', randomUUID())
      .expect(400);
  });

  it('cancels a departing worker’s open tasks', async () => {
    const publicId = await acceptedReport();
    const { client: leaver, userId: leaverId } = await member(
      `leaver-${randomUUID()}@dncc.gov.bd`,
      'WORKER',
    );
    const assignmentId = await assignedTo(publicId, leaverId);
    await leaver.post(`/work/tasks/${assignmentId}/accept`).expect(200);

    const membership = await h.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId, userId: leaverId },
    });
    // An Org Admin removes the worker through the API.
    const { client: orgAdmin, userId: adminId } = await h.signedIn(
      `admin-${randomUUID()}@dncc.gov.bd`,
    );
    await h.prisma.organizationMember.create({
      data: { organizationId, userId: adminId, role: 'ORG_ADMIN', status: 'ACTIVE' },
    });
    await orgAdmin.delete(`/organizations/${organizationId}/members/${membership.id}`).expect(200);

    const after = await workspace(publicId);
    expect(after.status).toBe('ACCEPTED');
    expect(after.assignments[0]?.state).toBe('CANCELLED');
    await task(leaver, assignmentId, 404);
  });

  it('stores assignment history append-only', async () => {
    const publicId = await acceptedReport();
    const assignmentId = await assignedTo(publicId, workerId);
    await expect(
      h.prisma.reportAssignment.update({
        where: { id: assignmentId },
        data: { workerId: worker2Id },
      }),
    ).rejects.toThrow(/only the state/);
    const event = await h.prisma.assignmentEvent.findFirstOrThrow({ where: { assignmentId } });
    await expect(h.prisma.assignmentEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});
