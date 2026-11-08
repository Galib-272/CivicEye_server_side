import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiServiceError, analyzePhoto, serviceVersion } from './ai-client';
import { aiReviewSchema } from './ai.schemas';

const valid = {
  modelVersion: 'road-damage-2026.11.08',
  label: 'crack',
  confidence: 0.82,
  uncertain: false,
  probabilities: { pothole: 0.1, crack: 0.82, asphalt_damage: 0.05, no_damage: 0.03 },
  damageProbability: 0.97,
  detections: [{ box: [0, 0.1, 0.5, 0.9], score: 0.7 }],
  quality: { brightness: 0.5, sharpness: 80, warnings: ['blurry'] },
  timingsMs: { total: 200 },
};

describe('AI service client', () => {
  let server: Server;
  let reply: { status: number; body: unknown; delayMs?: number };
  let seen: { authorization?: string; url?: string };
  let config: { enabled: boolean; serviceUrl: string; token: string; timeoutMs: number };

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen = { authorization: req.headers.authorization, url: req.url };
      req.resume();
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    config = {
      enabled: true,
      serviceUrl: `http://127.0.0.1:${port}`,
      token: 'x'.repeat(32),
      timeoutMs: 1000,
    };
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const photo = Buffer.from('jpeg bytes');

  it('sends the photo with the token and returns the checked answer', async () => {
    reply = { status: 200, body: valid };
    await expect(analyzePhoto(config, photo)).resolves.toEqual(valid);
    expect(seen).toEqual({ authorization: `Bearer ${'x'.repeat(32)}`, url: '/v1/analyze' });
  });

  it.each([
    [401, {}, 'unauthorized', true],
    [422, { detail: 'unreadable_image' }, 'rejected_image', true],
    [413, {}, 'rejected_image', true],
    [503, {}, 'server_error', false],
    [200, { ...valid, label: 'banana' }, 'bad_response', true],
    [200, { ...valid, confidence: 1.5 }, 'bad_response', true],
    [200, { ...valid, detections: [{ box: [0, 0, 2, 1], score: 0.5 }] }, 'bad_response', true],
    [200, 'not json', 'bad_response', true],
  ])('answer %i %j → %s', async (status, body, code, permanent) => {
    reply = { status, body };
    const error = await analyzePhoto(config, photo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServiceError);
    expect(error).toMatchObject({ code, permanent });
  });

  it('gives up after the timeout and can be retried', async () => {
    reply = { status: 200, body: valid, delayMs: 1500 };
    await expect(analyzePhoto(config, photo)).rejects.toMatchObject({
      code: 'timeout',
      permanent: false,
    });
  });

  it('reports an unreachable service', async () => {
    await expect(
      analyzePhoto({ ...config, serviceUrl: 'http://127.0.0.1:9' }, photo),
    ).rejects.toMatchObject({ code: 'unreachable', permanent: false });
    await expect(serviceVersion({ ...config, serviceUrl: 'http://127.0.0.1:9' })).resolves.toBe(
      null,
    );
  });

  it('reads the model version from the health check', async () => {
    reply = { status: 200, body: { status: 'ok', modelVersion: 'road-damage-2026.11.08' } };
    await expect(serviceVersion(config)).resolves.toBe('road-damage-2026.11.08');
  });
});

describe('AI review input', () => {
  it.each([
    [{ action: 'ACCEPTED' }, true],
    [{ action: 'DISMISSED' }, true],
    [{ action: 'CORRECTED', correctedLabel: 'no_damage' }, true],
    [{ action: 'CORRECTED' }, false],
    [{ action: 'ACCEPTED', correctedLabel: 'crack' }, false],
    [{ action: 'CORRECTED', correctedLabel: 'banana' }, false],
    [{ action: 'ACCEPTED', extra: 1 }, false],
  ])('%j valid: %s', (input, ok) => {
    expect(aiReviewSchema.safeParse(input).success).toBe(ok);
  });
});
