import { loadConfig } from '../config/app-config';
import { bullmqConnection } from './queue-connection';

function configWith(redisUrl: string) {
  return loadConfig({
    NODE_ENV: 'test',
    WEB_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: redisUrl,
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    EMAIL_FROM: 'CivicEye <test@example.test>',
    SMTP_URL: 'smtp://127.0.0.1:1025',
  });
}

describe('bullmqConnection', () => {
  it('parses a plain local URL', () => {
    expect(bullmqConnection(configWith('redis://localhost:6379'))).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      tls: undefined,
      maxRetriesPerRequest: null,
    });
  });

  it('parses credentials, database index and TLS', () => {
    expect(
      bullmqConnection(configWith('rediss://worker:p%40ss@cache.internal:6380/2')),
    ).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      username: 'worker',
      password: 'p@ss',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });
});
