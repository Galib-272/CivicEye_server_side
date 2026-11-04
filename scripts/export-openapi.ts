/**
 * Writes the OpenAPI document to openapi/openapi.json without starting the server or
 * connecting to PostgreSQL/Redis. The frontend generates its API types from this file,
 * and CI fails if the committed copy is out of date.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { buildOpenApiDocument, createApp } from '../src/app.factory';
import { loadConfig } from '../src/config/app-config';

// Placeholder values from .env.example are enough: nothing connects during export.
loadDotenv({ path: resolve(__dirname, '../.env.example'), quiet: true });

async function main(): Promise<void> {
  const loaded = loadConfig();
  // Nothing may connect during export (CI has no storage service): no bucket setup, no workers.
  const config = {
    ...loaded,
    openApiEnabled: false,
    logLevel: 'silent' as const,
    runWorkers: false,
    storage: { ...loaded.storage, createBucket: false },
  };
  const app = await createApp(config);
  await app.init();
  const document = buildOpenApiDocument(app);
  const outputPath = resolve(__dirname, '../openapi/openapi.json');
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  process.stdout.write(`OpenAPI document written to ${outputPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
