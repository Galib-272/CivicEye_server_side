import { VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { assignRequestId, REQUEST_ID_HEADER } from './common/http/request-id';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import type { AppConfig } from './config/app-config';

export const API_PREFIX = 'api';
export const OPENAPI_PATH = 'api/docs';

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    // Body parsing is registered explicitly in configureApp, after request-ID assignment.
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  configureApp(app, config);
  return app;
}

/** HTTP pipeline shared by the server entry point, OpenAPI export and integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  // First middleware: every response, including body-parser errors, carries a request ID.
  app.use(assignRequestId);
  app.useBodyParser('json', { limit: '100kb' });

  app.use(
    helmet({
      // The API serves JSON only. Swagger UI needs inline assets, so the default CSP is
      // disabled while API docs are enabled (off by default in production).
      contentSecurityPolicy: config.openApiEnabled ? false : undefined,
      crossOriginResourcePolicy: { policy: 'same-site' },
      frameguard: { action: 'deny' },
    }),
  );

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    exposedHeaders: [REQUEST_ID_HEADER],
    maxAge: 600,
  });

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  if (config.openApiEnabled) {
    SwaggerModule.setup(OPENAPI_PATH, app, () => buildOpenApiDocument(app));
  }
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = new DocumentBuilder()
    .setTitle('CivicEye API')
    .setDescription(
      'CivicEye civic issue reporting platform API. All responses use the standard envelope.',
    )
    .setVersion('1')
    .build();
  return SwaggerModule.createDocument(app, document);
}
