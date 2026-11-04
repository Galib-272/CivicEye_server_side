import { Client } from 'pg';
import { prisma, startEnvironment, type TestEnvironment } from './environment';

describe('Database migrations (PostGIS)', () => {
  let env: TestEnvironment;
  let client: Client;

  beforeAll(async () => {
    env = await startEnvironment();
    const deploy = prisma(['migrate', 'deploy'], env.databaseUrl);
    if (deploy.status !== 0) throw new Error(`migrate deploy failed:\n${deploy.output}`);
    client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await env?.stop();
  });

  it('installs the required extensions', async () => {
    const { rows } = await client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = ANY($1) ORDER BY extname`,
      [['citext', 'pg_trgm', 'postgis']],
    );
    expect(rows.map((row) => row.extname)).toEqual(['citext', 'pg_trgm', 'postgis']);
  });

  it('supports EPSG:4326 point-in-polygon and geography distance queries', async () => {
    const { rows } = await client.query<{ inside: boolean; meters: number }>(`
      SELECT
        ST_Covers(
          ST_MakeEnvelope(90.30, 23.70, 90.50, 23.90, 4326),
          ST_SetSRID(ST_MakePoint(90.41, 23.81), 4326)
        ) AS inside,
        ST_Distance(
          ST_SetSRID(ST_MakePoint(90.41, 23.81), 4326)::geography,
          ST_SetSRID(ST_MakePoint(90.42, 23.81), 4326)::geography
        ) AS meters
    `);
    expect(rows[0]?.inside).toBe(true);
    // One hundredth of a degree of longitude at ~23.8°N is roughly 1 km.
    expect(rows[0]?.meters).toBeGreaterThan(1000);
    expect(rows[0]?.meters).toBeLessThan(1030);
  });

  it('is idempotent: deploying again applies nothing', () => {
    const second = prisma(['migrate', 'deploy'], env.databaseUrl);
    expect(second.status).toBe(0);
    expect(second.output).toMatch(/No pending migrations/i);
  });

  it('matches the Prisma schema with no drift', () => {
    const diff = prisma(
      [
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      env.databaseUrl,
    );
    // Exit code 0 = no difference, 2 = drift detected.
    expect({ status: diff.status, output: diff.output }).toEqual({
      status: 0,
      output: expect.any(String) as string,
    });
  });
});
