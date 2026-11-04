import {
  STRONG_PASSWORD,
  startAuthHarness,
  tokenFromEmail,
  type AuthHarness,
} from './auth-harness';

type Body = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; details: Array<{ code?: string }> };
};

describe('Accounts and sessions (real PostgreSQL and Redis)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await startAuthHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
    h.mail.clear();
  });

  describe('registration', () => {
    it('creates an unverified account and emails a verification link in the fragment', async () => {
      const response = await h
        .client()
        .post('/auth/register', {
          name: 'Rahima Akter',
          email: 'Rahima@Example.test',
          password: STRONG_PASSWORD,
        })
        .expect(202);
      expect(response.body).toMatchObject({ success: true, data: { accepted: true } });

      const user = await h.prisma.user.findUniqueOrThrow({
        where: { email: 'rahima@example.test' },
      });
      expect(user).toMatchObject({
        status: 'PENDING_VERIFICATION',
        platformRole: 'CITIZEN',
        emailVerifiedAt: null,
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);

      const email = await h.mail.waitFor('rahima@example.test', /Verify/);
      expect(email.text).toMatch(/\/en\/verify-email#token=/);
    });

    it('responds identically for an already registered email and tells the owner instead', async () => {
      await h.createUser({ email: 'taken@example.test' });
      const first = await h.client().post('/auth/register', {
        name: 'Someone',
        email: 'taken@example.test',
        password: STRONG_PASSWORD,
      });
      const fresh = await h.client().post('/auth/register', {
        name: 'Someone',
        email: 'fresh@example.test',
        password: STRONG_PASSWORD,
      });

      expect(first.status).toBe(202);
      expect(fresh.status).toBe(202);
      expect((first.body as Body).data).toEqual((fresh.body as Body).data);
      expect(await h.prisma.user.count({ where: { email: 'taken@example.test' } })).toBe(1);
      await h.mail.waitFor('taken@example.test', /About your CivicEye account/);
    });

    it('rejects weak passwords with machine-readable issue codes', async () => {
      const response = await h
        .client()
        .post('/auth/register', {
          name: 'Weak',
          email: 'weak@example.test',
          password: 'password1234',
        })
        .expect(400);
      expect((response.body as Body).error?.details.map((d) => d.code)).toEqual([
        'PASSWORD_TOO_COMMON',
      ]);
    });

    it('rejects attempts to set privileged fields', async () => {
      const response = await h
        .client()
        .post('/auth/register', {
          name: 'Sneaky',
          email: 'sneaky@example.test',
          password: STRONG_PASSWORD,
          platformRole: 'SUPER_ADMIN',
        })
        .expect(400);
      expect((response.body as Body).error?.code).toBe('VALIDATION_ERROR');
      expect(await h.prisma.user.count({ where: { email: 'sneaky@example.test' } })).toBe(0);
    });

    it('limits registrations per client', async () => {
      const client = h.client();
      for (let i = 0; i < 10; i += 1) {
        await client
          .post('/auth/register', {
            name: 'Bulk',
            email: `bulk${i}@example.test`,
            password: STRONG_PASSWORD,
          })
          .expect(202);
      }
      const limited = await client.post('/auth/register', {
        name: 'Bulk',
        email: 'bulk-x@example.test',
        password: STRONG_PASSWORD,
      });
      expect(limited.status).toBe(429);
      expect((limited.body as Body).error?.code).toBe('RATE_LIMITED');
    });
  });

  describe('sign-in', () => {
    beforeAll(async () => {
      await h.createUser({ email: 'login@example.test', name: 'Login User' });
    });

    it('gives the same error for a wrong password and an unknown email', async () => {
      const wrongPassword = await h
        .client()
        .post('/auth/login', { email: 'login@example.test', password: 'wrong password!!' });
      const unknown = await h
        .client()
        .post('/auth/login', { email: 'nobody@example.test', password: 'wrong password!!' });
      expect(wrongPassword.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect((wrongPassword.body as Body).error?.code).toBe('INVALID_CREDENTIALS');
      expect((unknown.body as Body).error?.code).toBe('INVALID_CREDENTIALS');
    });

    it('sets an HttpOnly SameSite=Lax session cookie and returns a CSRF token', async () => {
      const client = h.client();
      const response = await client.login('login@example.test');
      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toMatch(/civiceye_session=[A-Za-z0-9_-]{43}/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(client.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const me = await client.get('/auth/me').expect(200);
      expect((me.body as Body).data).toMatchObject({
        user: { email: 'login@example.test' },
        mfa: 'none',
      });
    });

    it('stores only a hash of the session token', async () => {
      const client = h.client();
      const response = await client.login('login@example.test');
      const token =
        /civiceye_session=([^;]+)/.exec(String(response.headers['set-cookie']))?.[1] ?? '';
      expect(await h.prisma.userSession.count({ where: { tokenHash: token } })).toBe(0);
      expect(await h.redis.exists(`civiceye:session:${token}`)).toBe(0);
    });

    it('rejects state-changing requests without the CSRF token', async () => {
      const client = h.client();
      await client.login('login@example.test');
      client.csrfToken = 'not-the-right-token';
      const response = await client.patch('/users/me', { name: 'Changed' }).expect(403);
      expect((response.body as Body).error?.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects state-changing requests from other origins', async () => {
      const response = await h
        .client()
        .agent.post('/api/v1/auth/login')
        .set('Origin', 'https://attacker.example')
        .send({ email: 'login@example.test', password: STRONG_PASSWORD })
        .expect(403);
      expect((response.body as Body).error?.code).toBe('FORBIDDEN');
    });

    it('requires authentication for account endpoints', async () => {
      const response = await h.client().get('/auth/me').expect(401);
      expect((response.body as Body).error?.code).toBe('UNAUTHENTICATED');
    });

    it('ends the session on logout', async () => {
      const client = h.client();
      await client.login('login@example.test');
      await client.post('/auth/logout').expect(200);
      await client.get('/auth/me').expect(401);
    });

    it('locks out repeated attempts against one email', async () => {
      const client = h.client();
      for (let i = 0; i < 10; i += 1) {
        await client
          .post('/auth/login', { email: 'login@example.test', password: 'wrong password!!' })
          .expect(401);
      }
      await client
        .post('/auth/login', { email: 'login@example.test', password: STRONG_PASSWORD })
        .expect(429);
    });
  });

  describe('email verification', () => {
    it('verifies the email once and activates the account', async () => {
      await h
        .client()
        .post('/auth/register', {
          name: 'Verify Me',
          email: 'verify@example.test',
          password: STRONG_PASSWORD,
        })
        .expect(202);
      const token = tokenFromEmail(await h.mail.waitFor('verify@example.test', /Verify/));

      await h.client().post('/auth/verify-email', { token }).expect(200);
      const user = await h.prisma.user.findUniqueOrThrow({
        where: { email: 'verify@example.test' },
      });
      expect(user.status).toBe('ACTIVE');
      expect(user.emailVerifiedAt).not.toBeNull();

      const reuse = await h.client().post('/auth/verify-email', { token }).expect(400);
      expect((reuse.body as Body).error?.code).toBe('INVALID_TOKEN');
    });

    it('lets a signed-in unverified user request a new link, invalidating the old one', async () => {
      await h
        .client()
        .post('/auth/register', {
          name: 'Resend Me',
          email: 'resend@example.test',
          password: STRONG_PASSWORD,
        })
        .expect(202);
      const oldToken = tokenFromEmail(await h.mail.waitFor('resend@example.test', /Verify/));
      h.mail.clear();

      const client = h.client();
      await client.login('resend@example.test');
      await client.post('/auth/resend-verification').expect(202);
      const newToken = tokenFromEmail(await h.mail.waitFor('resend@example.test', /Verify/));

      expect(newToken).not.toBe(oldToken);
      await h.client().post('/auth/verify-email', { token: oldToken }).expect(400);
      await h.client().post('/auth/verify-email', { token: newToken }).expect(200);
    });
  });

  describe('password reset', () => {
    it('responds identically for known and unknown emails', async () => {
      await h.createUser({ email: 'forgot@example.test' });
      const known = await h
        .client()
        .post('/auth/forgot-password', { email: 'forgot@example.test' });
      const unknown = await h
        .client()
        .post('/auth/forgot-password', { email: 'ghost@example.test' });
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect((known.body as Body).data).toEqual((unknown.body as Body).data);
      await h.mail.waitFor('forgot@example.test', /Reset/);
      expect(h.mail.sent.some((message) => message.to === 'ghost@example.test')).toBe(false);
    });

    it('sets the new password, signs out every session and rejects reuse of the link', async () => {
      await h.createUser({ email: 'reset@example.test', name: 'Reset User' });
      const existingSession = h.client();
      await existingSession.login('reset@example.test');

      await h.client().post('/auth/forgot-password', { email: 'reset@example.test' }).expect(202);
      const token = tokenFromEmail(await h.mail.waitFor('reset@example.test', /Reset/));
      const newPassword = 'a brand new long passphrase';

      await h.client().post('/auth/reset-password', { token, newPassword }).expect(200);
      await existingSession.get('/auth/me').expect(401);
      await h.client().login('reset@example.test', newPassword);
      await h
        .client()
        .post('/auth/login', { email: 'reset@example.test', password: STRONG_PASSWORD })
        .expect(401);
      await h.mail.waitFor('reset@example.test', /password was changed/);

      const reuse = await h
        .client()
        .post('/auth/reset-password', { token, newPassword: 'yet another long passphrase' })
        .expect(400);
      expect((reuse.body as Body).error?.code).toBe('INVALID_TOKEN');
    });

    it('rejects expired reset links', async () => {
      await h.createUser({ email: 'expired@example.test' });
      await h.client().post('/auth/forgot-password', { email: 'expired@example.test' }).expect(202);
      const token = tokenFromEmail(await h.mail.waitFor('expired@example.test', /Reset/));
      await h.prisma.passwordResetToken.updateMany({
        where: { user: { email: 'expired@example.test' } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await h
        .client()
        .post('/auth/reset-password', { token, newPassword: 'a brand new long passphrase' })
        .expect(400);
    });
  });

  describe('account settings', () => {
    it('updates the name but never the role or status', async () => {
      await h.createUser({ email: 'profile@example.test', name: 'Before' });
      const client = h.client();
      await client.login('profile@example.test');

      const updated = await client
        .patch('/users/me', { name: 'After', preferredLocale: 'bn' })
        .expect(200);
      expect((updated.body as Body).data).toMatchObject({ name: 'After', preferredLocale: 'bn' });

      await client.patch('/users/me', { platformRole: 'SUPER_ADMIN' }).expect(400);
      await client.patch('/users/me', { status: 'ACTIVE' }).expect(400);
      const user = await h.prisma.user.findUniqueOrThrow({
        where: { email: 'profile@example.test' },
      });
      expect(user.platformRole).toBe('CITIZEN');
    });

    it('changes the password, keeps this device signed in and signs out the others', async () => {
      await h.createUser({ email: 'change@example.test', name: 'Change User' });
      const current = h.client();
      const other = h.client();
      await current.login('change@example.test');
      await other.login('change@example.test');

      const wrong = await current
        .patch('/users/me/password', {
          currentPassword: 'not my password',
          newPassword: 'a brand new long passphrase',
        })
        .expect(401);
      expect((wrong.body as Body).error?.code).toBe('INVALID_CREDENTIALS');

      const changed = await current
        .patch('/users/me/password', {
          currentPassword: STRONG_PASSWORD,
          newPassword: 'a brand new long passphrase',
        })
        .expect(200);
      current.csrfToken = ((changed.body as Body).data as { csrfToken: string }).csrfToken;

      await current.get('/auth/me').expect(200);
      await other.get('/auth/me').expect(401);
    });

    it('lists sessions and lets users sign out their own devices only', async () => {
      await h.createUser({ email: 'devices@example.test' });
      await h.createUser({ email: 'stranger@example.test' });
      const laptop = h.client();
      const phone = h.client();
      const stranger = h.client();
      await laptop.login('devices@example.test');
      await phone.login('devices@example.test');
      await stranger.login('stranger@example.test');

      const listed = await laptop.get('/auth/sessions').expect(200);
      const sessions = (listed.body as { data: Array<{ id: string; current: boolean }> }).data;
      expect(sessions).toHaveLength(2);
      const phoneSession = sessions.find((session) => !session.current);
      expect(phoneSession).toBeDefined();

      // Someone else's session ID looks exactly like a missing one.
      await stranger.delete(`/auth/sessions/${phoneSession?.id}`).expect(404);
      await phone.get('/auth/me').expect(200);

      await laptop.delete(`/auth/sessions/${phoneSession?.id}`).expect(200);
      await phone.get('/auth/me').expect(401);
      await laptop.get('/auth/me').expect(200);
    });
  });

  it('records security events in the audit log', async () => {
    const actions = await h.prisma.auditLog.findMany({
      select: { action: true },
      distinct: ['action'],
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'auth.register',
        'auth.login',
        'auth.logout',
        'auth.email_verified',
        'auth.password_reset_requested',
        'auth.password_reset',
        'user.password_changed',
        'session.revoked',
      ]),
    );
    const serialized = JSON.stringify(await h.prisma.auditLog.findMany());
    expect(serialized).not.toContain(STRONG_PASSWORD);
  });
});
