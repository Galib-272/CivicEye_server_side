import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';
import { MaintenanceWorker } from '../../src/modules/notifications/maintenance.worker';
import {
  MAX_EVENT_ATTEMPTS,
  NotificationDispatcher,
} from '../../src/modules/notifications/notification-dispatcher.service';
import { NotificationEmailWorker } from '../../src/modules/notifications/notification-email.worker';
import { startAuthHarness, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = { data: T; error?: { code: string } };
type Item = {
  id: string;
  type: string;
  reportPublicId: string | null;
  path: string;
  read: boolean;
};

const AREA = { minLon: 90.35, minLat: 23.78, maxLon: 90.45, maxLat: 23.88 };
const TITLE = 'Secret title: broken pipe behind house 12';
const DESCRIPTION = 'Private description that must never appear in an email body.';

async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Notifications, emails and live updates (real PostGIS, Redis and storage)', () => {
  let h: AuthHarness;
  let citizen: Client;
  let citizenId: string;
  let reviewer: Client;
  let worker: Client;
  let workerId: string;
  let otherReviewer: Client;
  let organizationId: string;
  let potholeId: string;
  let baseUrl: string;
  const sockets: Socket[] = [];

  async function member(email: string, role: 'ORG_REVIEWER' | 'WORKER', orgId = organizationId) {
    const { client, userId } = await h.signedIn(email, `${role} person`);
    await h.prisma.organizationMember.create({
      data: { organizationId: orgId, userId, role, status: 'ACTIVE' },
    });
    return { client, userId };
  }

  async function uploadPhoto(client: Client) {
    const content = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#445566' },
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
    return eventually(async () => {
      const view = await client.get(`/media/${mediaId}`).expect(200);
      return (view.body as Body<{ status: string }>).data.status === 'PROCESSED'
        ? mediaId
        : undefined;
    });
  }

  async function submit() {
    const response = await citizen
      .post('/reports', {
        title: TITLE,
        description: DESCRIPTION,
        categoryId: potholeId,
        latitude: 23.86,
        longitude: 90.37,
        mediaIds: [await uploadPhoto(citizen)],
      })
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return (response.body as Body<{ publicId: string }>).data.publicId;
  }

  const base = (publicId: string) => `/organizations/${organizationId}/reports/${publicId}`;
  async function orgAct(publicId: string, action: string, body: object = {}) {
    const view = await reviewer.get(base(publicId)).expect(200);
    const { version } = (view.body as Body<{ version: number }>).data;
    return reviewer
      .post(`${base(publicId)}/${action}`, body)
      .set('If-Match', String(version))
      .expect(200);
  }

  async function notifications(client: Client) {
    const response = await client.get('/notifications').expect(200);
    return (response.body as Body<Item[]>).data;
  }

  /** Waits until the client has a notification of this type for this report. */
  function waitForNotification(client: Client, type: string, publicId: string) {
    return eventually(async () =>
      (await notifications(client)).find(
        (item) => item.type === type && item.reportPublicId === publicId,
      ),
    );
  }

  async function connect(client: Client): Promise<Socket> {
    const response = await client.post('/notifications/realtime-ticket').expect(200);
    const { ticket } = (response.body as Body<{ ticket: string }>).data;
    const socket = io(baseUrl, {
      path: '/socket.io',
      auth: { ticket },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('ready', () => resolve());
      socket.once('unauthorized', () => reject(new Error('unauthorized')));
      setTimeout(() => reject(new Error('no ready event')), 5_000);
    });
    return socket;
  }

  beforeAll(async () => {
    h = await startAuthHarness([], { runWorkers: true });
    await h.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(h.app.getHttpServer().address() as AddressInfo).port}`;
    potholeId = (await h.prisma.reportCategory.findUniqueOrThrow({ where: { slug: 'pothole' } }))
      .id;
    ({ client: citizen, userId: citizenId } = await h.signedIn('citizen@example.test', 'Rahima'));
    const organization = await h.prisma.organization.create({
      data: {
        name: 'Dhaka North',
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
    ({ client: reviewer } = await member('reviewer@dncc.gov.bd', 'ORG_REVIEWER'));
    ({ client: worker, userId: workerId } = await member('worker@dncc.gov.bd', 'WORKER'));
    const other = await h.prisma.organization.create({
      data: {
        name: 'Elsewhere',
        officialEmailDomain: 'else.gov.bd',
        verificationState: 'VERIFIED',
      },
    });
    ({ client: otherReviewer } = await member('reviewer@else.gov.bd', 'ORG_REVIEWER', other.id));
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
  });

  it('tells reviewers about a new report, never the citizen who sent it', async () => {
    const publicId = await submit();
    const item = await waitForNotification(reviewer, 'NEW_REPORT', publicId);
    expect(item.path).toBe(`/organizations/${organizationId}/reports/${publicId}`);
    expect((await notifications(citizen)).some((n) => n.type === 'NEW_REPORT')).toBe(false);
    expect((await notifications(otherReviewer)).length).toBe(0);

    // Emails: generic subject, the report ID, and none of the report's content.
    const email = await h.mail.waitFor('reviewer@dncc.gov.bd', /New activity/, 10_000);
    expect(email.text).toContain(publicId);
    for (const secret of [TITLE, DESCRIPTION, 'Rahima', 'citizen@example.test']) {
      expect(email.subject).not.toContain(secret);
      expect(email.text).not.toContain(secret);
      expect(email.html).not.toContain(secret);
    }

    // Read state belongs to the recipient only.
    await citizen.patch(`/notifications/${item.id}/read`).expect(404);
    const read = await reviewer.patch(`/notifications/${item.id}/read`).expect(200);
    expect((read.body as Body<{ count: number }>).data.count).toBeGreaterThanOrEqual(0);
    await reviewer.post('/notifications/read-all').expect(200);
    const count = await reviewer.get('/notifications/unread-count').expect(200);
    expect((count.body as Body<{ count: number }>).data.count).toBe(0);
    // Notifications cannot be rewritten in the database.
    await expect(
      h.prisma.notification.update({ where: { id: item.id }, data: { readAt: null } }),
    ).rejects.toThrow(/only marking as read/);
  });

  it('follows a report through review and work, notifying each person once', async () => {
    const publicId = await submit();
    await orgAct(publicId, 'start-review');
    await waitForNotification(citizen, 'REPORT_UNDER_REVIEW', publicId);
    await orgAct(publicId, 'request-information', {
      message: 'Please tell us exactly which lane is affected.',
    });
    await waitForNotification(citizen, 'INFORMATION_REQUESTED', publicId);
    const email = await h.mail.waitFor('citizen@example.test', /New activity/, 10_000);
    expect(email.text).not.toContain('which lane');

    await citizen
      .post(`/reports/${publicId}/additional-information`, {
        message: 'The left lane, near the gate.',
      })
      .expect(200);
    await waitForNotification(reviewer, 'INFORMATION_PROVIDED', publicId);

    await orgAct(publicId, 'accept');
    await waitForNotification(citizen, 'REPORT_ACCEPTED', publicId);
    await orgAct(publicId, 'assign', { workerId });
    const task = await waitForNotification(worker, 'TASK_ASSIGNED', publicId);
    expect(task.path).toMatch(/^\/work\/[0-9a-f-]{36}$/);
    await waitForNotification(citizen, 'REPORT_ASSIGNED', publicId);

    // The actor is never notified about their own action.
    expect((await notifications(reviewer)).some((n) => n.type === 'REPORT_ACCEPTED')).toBe(false);
    // Exactly one notification per person and event.
    const accepted = (await notifications(citizen)).filter(
      (n) => n.type === 'REPORT_ACCEPTED' && n.reportPublicId === publicId,
    );
    expect(accepted).toHaveLength(1);
  });

  it('respects email preferences but still shows the notification in the app', async () => {
    await citizen
      .put('/notifications/preferences', {
        emailMyReports: false,
        emailMyTasks: true,
        emailOrganization: true,
      })
      .expect(200);
    const publicId = await submit();
    h.mail.clear();
    await orgAct(publicId, 'start-review');
    await waitForNotification(citizen, 'REPORT_UNDER_REVIEW', publicId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(h.mail.sent.filter((message) => message.to === 'citizen@example.test')).toHaveLength(0);
    await citizen
      .put('/notifications/preferences', {
        emailMyReports: true,
        emailMyTasks: true,
        emailOrganization: true,
      })
      .expect(200);
  });

  it('never creates duplicates when an event is processed again', async () => {
    const publicId = await submit();
    await waitForNotification(reviewer, 'NEW_REPORT', publicId);
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'report.submitted', status: 'PROCESSED' },
      orderBy: { createdAt: 'desc' },
    });
    await h.prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'PENDING' } });
    await h.app.get(NotificationDispatcher).dispatchDue();
    expect(await h.prisma.notification.count({ where: { eventId: event.id } })).toBe(1);
  });

  it('retries failing events, then shows them to Super Admins for a manual retry', async () => {
    const broken = await h.prisma.outboxEvent.create({
      data: { type: 'report.does_not_exist', payload: {} },
    });
    const dispatcher = h.app.get(NotificationDispatcher);
    for (let attempt = 0; attempt < MAX_EVENT_ATTEMPTS; attempt += 1) {
      await h.prisma.outboxEvent.update({
        where: { id: broken.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await dispatcher.dispatchDue();
    }
    const failed = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: broken.id } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_EVENT_ATTEMPTS });
    expect(failed.lastError).toMatch(/Unknown outbox event type/);

    const admin = await h.superAdmin('root@civiceye.test');
    const health = await admin.get('/admin/delivery-health').expect(200);
    expect(JSON.stringify(health.body)).toContain(broken.id);
    await reviewer.get('/admin/delivery-health').expect(403);
    await admin.post(`/admin/delivery-health/events/${broken.id}/retry`).expect(200);
    expect(
      (await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: broken.id } })).status,
    ).toBe('PENDING');
    await h.prisma.outboxEvent.update({ where: { id: broken.id }, data: { status: 'FAILED' } });
  });

  it('records failed email attempts and never sends the same email twice', async () => {
    const reviewerId = (
      await h.prisma.user.findUniqueOrThrow({ where: { email: 'reviewer@dncc.gov.bd' } })
    ).id;
    const event = await h.prisma.outboxEvent.create({
      data: { type: 'manual.test', payload: {}, status: 'PROCESSED', processedAt: new Date() },
    });
    const notification = await h.prisma.notification.create({
      data: {
        recipientId: reviewerId,
        eventId: event.id,
        type: 'NEW_REPORT',
        reportPublicId: 'CE-TEST-0001',
        organizationId,
      },
    });
    const emailWorker = h.app.get(NotificationEmailWorker);
    const original = h.mail.send.bind(h.mail);
    h.mail.send = () => Promise.reject(new Error('SMTP unavailable'));
    try {
      await expect(emailWorker.send(notification.id)).rejects.toThrow(/SMTP unavailable/);
    } finally {
      h.mail.send = original;
    }
    h.mail.clear();
    await emailWorker.send(notification.id);
    await emailWorker.send(notification.id);
    expect(h.mail.sent.filter((message) => message.to === 'reviewer@dncc.gov.bd')).toHaveLength(1);
    const attempts = await h.prisma.notificationDelivery.findMany({
      where: { notificationId: notification.id },
      orderBy: { attemptedAt: 'asc' },
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(['FAILED', 'SENT']);
  });

  it('closes resolved reports after 14 days and reminds about unaccepted tasks', async () => {
    const publicId = await submit();
    await orgAct(publicId, 'start-review');
    await orgAct(publicId, 'accept');
    await orgAct(publicId, 'assign', { workerId });
    const maintenance = h.app.get(MaintenanceWorker);

    const later = new Date(Date.now() + 49 * 3600 * 1000);
    expect(await maintenance.remindUnacceptedTasks(later)).toBeGreaterThanOrEqual(1);
    await waitForNotification(reviewer, 'ACCEPTANCE_OVERDUE', publicId);
    expect(await maintenance.remindUnacceptedTasks(later)).toBe(0); // only once

    await h.prisma.report.update({
      where: { publicId },
      data: { status: 'RESOLVED', resolvedAt: new Date(Date.now() - 15 * 24 * 3600 * 1000) },
    });
    expect(await maintenance.autoCloseResolved()).toBeGreaterThanOrEqual(1);
    const report = await h.prisma.report.findUniqueOrThrow({ where: { publicId } });
    expect(report.status).toBe('CLOSED');
    const last = await h.prisma.reportStatusHistory.findFirstOrThrow({
      where: { reportId: report.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(last).toMatchObject({ toStatus: 'CLOSED', actorContext: 'system', actorUserId: null });
    await waitForNotification(citizen, 'REPORT_CLOSED', publicId);
  });

  it('sends live updates only to the right people, with one-time tickets', async () => {
    const citizenSocket = await connect(citizen);
    const reviewerSocket = await connect(reviewer);
    const outsiderSocket = await connect(otherReviewer);
    const seen = { citizen: 0, reviewer: 0, outsider: 0 };
    citizenSocket.on('notifications.changed', () => (seen.citizen += 1));
    reviewerSocket.on('data.changed', () => (seen.reviewer += 1));
    outsiderSocket.onAny(() => (seen.outsider += 1));

    const publicId = await submit();
    await orgAct(publicId, 'start-review');
    await eventually(() =>
      Promise.resolve(seen.citizen > 0 && seen.reviewer > 0 ? true : undefined),
    );
    expect(seen.outsider).toBe(0);

    // A ticket works once; a made-up ticket never works.
    const response = await citizen.post('/notifications/realtime-ticket').expect(200);
    const { ticket } = (response.body as Body<{ ticket: string }>).data;
    const reuse = (value: string) => {
      const socket = io(baseUrl, {
        path: '/socket.io',
        auth: { ticket: value },
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(socket);
      return new Promise<string>((resolve) => {
        socket.once('ready', () => resolve('ready'));
        socket.once('unauthorized', () => resolve('unauthorized'));
        setTimeout(() => resolve('timeout'), 5_000);
      });
    };
    expect(await reuse(ticket)).toBe('ready');
    expect(await reuse(ticket)).toBe('unauthorized');
    expect(await reuse('made-up-ticket')).toBe('unauthorized');
    expect(citizenId).toBeTruthy();
  });
});
