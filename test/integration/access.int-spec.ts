import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Secret, TOTP } from 'otpauth';
import { AppModule } from '../../src/app.module';
import { Permission } from '../../src/modules/access/permissions';
import { RequirePermissions } from '../../src/modules/auth/auth.decorators';
import { startAuthHarness, STRONG_PASSWORD, type AuthHarness, type Client } from './auth-harness';

type Body = { data?: Record<string, unknown>; error?: { code: string } };

// Stand-in for Phase 4 report submission: requires a permission gated on a verified email.
@Controller({ path: 'verified-only-probe', version: '1' })
class VerifiedOnlyProbeController {
  @Post()
  @RequirePermissions(Permission.ReportCreate)
  create() {
    return { ok: true };
  }
}

function totpFor(secret: string): TOTP {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' });
}

/** A code for the next 30-second window, so it differs from any code already used now. */
function nextWindowCode(secret: string): string {
  return totpFor(secret).generate({ timestamp: Date.now() + 30_000 });
}

describe('Authorization, two-factor and administration (real PostgreSQL and Redis)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await startAuthHarness([VerifiedOnlyProbeController]);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
    h.mail.clear();
  });

  it('blocks unverified users from actions that need a verified email', async () => {
    await h.createUser({ email: 'unverified@example.test', verified: false });
    await h.createUser({ email: 'verified@example.test', verified: true });
    const unverified = h.client();
    const verified = h.client();
    await unverified.login('unverified@example.test');
    await verified.login('verified@example.test');

    const blocked = await unverified.post('/verified-only-probe').expect(403);
    expect((blocked.body as Body).error?.code).toBe('EMAIL_NOT_VERIFIED');
    await verified.post('/verified-only-probe').expect(201);
  });

  it('keeps administrative endpoints closed to citizens', async () => {
    await h.createUser({ email: 'citizen@example.test' });
    const citizen = h.client();
    await citizen.login('citizen@example.test');
    const response = await citizen.get('/admin/users').expect(403);
    expect((response.body as Body).error?.code).toBe('FORBIDDEN');
  });

  describe('Super Admin two-factor', () => {
    let admin: Client;
    let secret: string;
    let backupCodes: string[];

    it('requires two-factor setup before any admin action', async () => {
      await h.createUser({
        email: 'admin@example.test',
        name: 'Platform Admin',
        platformRole: 'SUPER_ADMIN',
      });
      admin = h.client();
      const login = await admin.login('admin@example.test');
      expect((login.body as Body).data?.mfa).toBe('setup_required');

      const blocked = await admin.get('/admin/users').expect(403);
      expect((blocked.body as Body).error?.code).toBe('MFA_REQUIRED');
      await admin.get('/auth/me').expect(200);
    });

    it('enables two-factor with a valid code and returns ten backup codes', async () => {
      const setup = await admin.post('/auth/mfa/setup').expect(200);
      const data = (setup.body as { data: { secret: string; otpauthUri: string } }).data;
      secret = data.secret;
      expect(data.otpauthUri).toMatch(/^otpauth:\/\/totp\/CivicEye:/);

      const stored = await h.prisma.userMfa.findFirstOrThrow({
        where: { user: { email: 'admin@example.test' } },
      });
      expect(stored.secretEncrypted).not.toContain(secret);

      await admin.post('/auth/mfa/enable', { code: '000000' }).expect(400);
      const enabled = await admin
        .post('/auth/mfa/enable', { code: totpFor(secret).generate() })
        .expect(200);
      const body = (
        enabled.body as {
          data: { backupCodes: string[]; auth: { csrfToken: string; mfa: string } };
        }
      ).data;
      backupCodes = body.backupCodes;
      admin.csrfToken = body.auth.csrfToken;

      expect(body.auth.mfa).toBe('verified');
      expect(backupCodes).toHaveLength(10);
      await admin.get('/admin/users').expect(200);
    });

    it('asks for a code at the next sign-in and rejects wrong or replayed codes', async () => {
      const second = h.client();
      const login = await second.login('admin@example.test');
      expect((login.body as Body).data?.mfa).toBe('pending');
      await second.get('/admin/users').expect(403);

      await second.post('/auth/mfa/challenge', { code: '123456' }).expect(400);
      const code = nextWindowCode(secret);
      const ok = await second.post('/auth/mfa/challenge', { code }).expect(200);
      second.csrfToken = ((ok.body as Body).data as { csrfToken: string }).csrfToken;
      await second.get('/admin/users').expect(200);

      const third = h.client();
      await third.login('admin@example.test');
      const replay = await third.post('/auth/mfa/challenge', { code }).expect(400);
      expect((replay.body as Body).error?.code).toBe('INVALID_MFA_CODE');
    });

    it('accepts each backup code exactly once', async () => {
      const first = h.client();
      await first.login('admin@example.test');
      await first.post('/auth/mfa/challenge', { backupCode: backupCodes[0] }).expect(200);

      const again = h.client();
      await again.login('admin@example.test');
      await again.post('/auth/mfa/challenge', { backupCode: backupCodes[0] }).expect(400);
      await again
        .post('/auth/mfa/challenge', { backupCode: (backupCodes[1] ?? '').toLowerCase() })
        .expect(200);
    });

    it('lets the admin list users and suspend a citizen, ending their sessions', async () => {
      const targetId = await h.createUser({ email: 'to-suspend@example.test' });
      const target = h.client();
      await target.login('to-suspend@example.test');

      const listed = await admin.get('/admin/users?q=to-suspend').expect(200);
      expect(
        (listed.body as { data: Array<{ id: string }>; meta: { total: number } }).meta.total,
      ).toBe(1);

      await admin.patch(`/admin/users/${targetId}/status`, { status: 'SUSPENDED' }).expect(400);
      const suspended = await admin
        .patch(`/admin/users/${targetId}/status`, {
          status: 'SUSPENDED',
          reason: 'Repeated spam reports',
        })
        .expect(200);
      expect((suspended.body as Body).data?.status).toBe('SUSPENDED');

      await target.get('/auth/me').expect(401);
      const login = await h
        .client()
        .post('/auth/login', { email: 'to-suspend@example.test', password: STRONG_PASSWORD });
      expect(login.status).toBe(403);
      expect((login.body as Body).error?.code).toBe('ACCOUNT_INACTIVE');

      const audit = await h.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.user_status_changed', targetId },
      });
      expect(audit).toMatchObject({
        reason: 'Repeated spam reports',
        metadata: { from: 'ACTIVE', to: 'SUSPENDED' },
      });

      await admin
        .patch(`/admin/users/${targetId}/status`, { status: 'ACTIVE', reason: 'Appeal accepted' })
        .expect(200);
      await h.client().login('to-suspend@example.test');
    });

    it('does not let an admin change their own status', async () => {
      const self = await h.prisma.user.findUniqueOrThrow({
        where: { email: 'admin@example.test' },
      });
      await admin
        .patch(`/admin/users/${self.id}/status`, {
          status: 'DEACTIVATED',
          reason: 'Testing self change',
        })
        .expect(403);
    });
  });

  it('keeps the audit log append-only at the database level', async () => {
    const entry = await h.prisma.auditLog.findFirstOrThrow();
    await expect(
      h.prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(h.prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(h.prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
  });

  it('refuses to start when a route declares no access rule', async () => {
    @Controller({ path: 'undeclared-probe', version: '1' })
    class UndeclaredController {
      @Get()
      get() {
        return {};
      }
    }
    @Module({ controllers: [UndeclaredController] })
    class UndeclaredModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(h.env.config()), UndeclaredModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await expect(app.init()).rejects.toThrow(/UndeclaredController\.get/);
    await app.close();
  });

  // Runs last: stops Redis for the rest of this suite.
  it('fails closed when the session and rate-limit store is unavailable', async () => {
    await h.createUser({ email: 'closed@example.test' });
    const client = h.client();
    await client.login('closed@example.test');

    await h.env.redis.stop();
    await client.get('/auth/me').expect(503);
    const login = await h
      .client()
      .post('/auth/login', { email: 'closed@example.test', password: STRONG_PASSWORD });
    expect(login.status).toBe(503);
    expect((login.body as Body).error?.code).toBe('SERVICE_UNAVAILABLE');
  });
});
