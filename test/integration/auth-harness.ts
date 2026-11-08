import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import type { AppConfig } from '../../src/config/app-config';
import { PrismaService } from '../../src/database/prisma.service';
import { PasswordService } from '../../src/modules/auth/password.service';
import {
  EMAIL_TRANSPORT,
  type EmailMessage,
  type EmailTransport,
} from '../../src/modules/email/email.service';
import { prisma as runPrisma, startEnvironment, type TestEnvironment } from './environment';

export const WEB_ORIGIN = 'http://localhost:3000';
export const STRONG_PASSWORD = 'correct horse battery staple';

/** Captures outgoing email instead of delivering it. */
export class CapturingTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];

  send(_from: string, message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Waits for the next email to an address (emails are sent in the background). */
  async waitFor(to: string, subjectPattern: RegExp, timeoutMs = 3000): Promise<EmailMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...this.sent]
        .reverse()
        .find((message) => message.to === to && subjectPattern.test(message.subject));
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No email to ${to} matching ${subjectPattern}`);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export function tokenFromEmail(message: EmailMessage): string {
  const match = /#token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error('Email contains no token link');
  return match[1];
}

export interface AuthHarness {
  env: TestEnvironment;
  app: NestExpressApplication;
  prisma: PrismaService;
  redis: Redis;
  mail: CapturingTransport;
  /** A cookie-keeping client that sends the web app's Origin header. */
  client(): Client;
  createUser(input: {
    email: string;
    name?: string;
    password?: string;
    platformRole?: 'CITIZEN' | 'SUPER_ADMIN';
    verified?: boolean;
  }): Promise<string>;
  resetRateLimits(): Promise<void>;
  /** Creates a Super Admin, signs in and completes two-factor setup. */
  superAdmin(email: string): Promise<Client>;
  /** Creates a verified citizen and signs them in. */
  signedIn(email: string, name?: string): Promise<{ client: Client; userId: string }>;
  close(): Promise<void>;
}

export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  csrfToken = '';

  constructor(app: NestExpressApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  get(path: string) {
    return this.agent.get(`/api/v1${path}`).set('Origin', WEB_ORIGIN);
  }

  post(path: string, body: object = {}) {
    return this.agent
      .post(`/api/v1${path}`)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', this.csrfToken)
      .send(body);
  }

  patch(path: string, body: object = {}) {
    return this.agent
      .patch(`/api/v1${path}`)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', this.csrfToken)
      .send(body);
  }

  put(path: string, body: object = {}) {
    return this.agent
      .put(`/api/v1${path}`)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', this.csrfToken)
      .send(body);
  }

  delete(path: string) {
    return this.agent
      .delete(`/api/v1${path}`)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', this.csrfToken);
  }

  /** Multipart upload of one file plus text fields. */
  upload(path: string, fields: Record<string, string>, file: { name: string; content: string }) {
    let req = this.agent
      .post(`/api/v1${path}`)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', this.csrfToken);
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    return req.attach('file', Buffer.from(file.content), file.name);
  }

  async login(email: string, password = STRONG_PASSWORD) {
    const response = await this.post('/auth/login', { email, password }).expect(200);
    this.csrfToken = (response.body as { data: { csrfToken: string } }).data.csrfToken;
    return response;
  }
}

export async function startAuthHarness(
  extraControllers: Type[] = [],
  options: { runWorkers?: boolean; config?: Partial<AppConfig> } = {},
): Promise<AuthHarness> {
  const env = await startEnvironment();
  const deploy = runPrisma(['migrate', 'deploy'], env.databaseUrl);
  if (deploy.status !== 0) throw new Error(`migrate deploy failed:\n${deploy.output}`);

  const mail = new CapturingTransport();
  // The global per-IP limit is raised so the whole suite (one client IP) is not throttled;
  // the authentication limits under test are separate and unchanged.
  const config = env.config({
    rateLimit: { windowSeconds: 60, maxRequests: 10_000 },
    runWorkers: options.runWorkers ?? false,
    ...options.config,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
    controllers: extraControllers,
  })
    .overrideProvider(EMAIL_TRANSPORT)
    .useValue(mail)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config);
  await app.init();

  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);
  const redis = new Redis(env.redisUrl);

  const harness: AuthHarness = {
    env,
    app,
    prisma,
    redis,
    mail,
    client: () => new Client(app),
    async createUser({
      email,
      name = 'Test User',
      password = STRONG_PASSWORD,
      platformRole = 'CITIZEN',
      verified = true,
    }) {
      const user = await prisma.user.create({
        data: {
          email,
          name,
          passwordHash: await passwords.hash(password),
          platformRole,
          status: verified ? 'ACTIVE' : 'PENDING_VERIFICATION',
          emailVerifiedAt: verified ? new Date() : null,
        },
        select: { id: true },
      });
      return user.id;
    },
    async superAdmin(email) {
      await harness.createUser({ email, name: 'Super Admin', platformRole: 'SUPER_ADMIN' });
      const client = new Client(app);
      await client.login(email);
      const setup = await client.post('/auth/mfa/setup').expect(200);
      const { secret } = (setup.body as { data: { secret: string } }).data;
      const code = new TOTP({
        secret: Secret.fromBase32(secret),
        digits: 6,
        period: 30,
      }).generate();
      const enabled = await client.post('/auth/mfa/enable', { code }).expect(200);
      client.csrfToken = (
        enabled.body as { data: { auth: { csrfToken: string } } }
      ).data.auth.csrfToken;
      return client;
    },
    async signedIn(email, name = 'Test User') {
      const userId = await harness.createUser({ email, name });
      const client = new Client(app);
      await client.login(email);
      return { client, userId };
    },
    async resetRateLimits() {
      const keys = await redis.keys('civiceye:authlimit:*');
      if (keys.length > 0) await redis.del(...keys);
    },
    async close() {
      redis.disconnect();
      await app.close();
      await env.stop();
    },
  };
  return harness;
}
