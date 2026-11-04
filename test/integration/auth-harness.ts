import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
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

  delete(path: string) {
    return this.agent
      .delete(`/api/v1${path}`)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', this.csrfToken);
  }

  async login(email: string, password = STRONG_PASSWORD) {
    const response = await this.post('/auth/login', { email, password }).expect(200);
    this.csrfToken = (response.body as { data: { csrfToken: string } }).data.csrfToken;
    return response;
  }
}

export async function startAuthHarness(extraControllers: Type[] = []): Promise<AuthHarness> {
  const env = await startEnvironment();
  const deploy = runPrisma(['migrate', 'deploy'], env.databaseUrl);
  if (deploy.status !== 0) throw new Error(`migrate deploy failed:\n${deploy.output}`);

  const mail = new CapturingTransport();
  // The global per-IP limit is raised so the whole suite (one client IP) is not throttled;
  // the authentication limits under test are separate and unchanged.
  const config = env.config({ rateLimit: { windowSeconds: 60, maxRequests: 10_000 } });
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

  return {
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
}
