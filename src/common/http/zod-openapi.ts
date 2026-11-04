import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiExtraModels,
  ApiQuery,
  ApiResponse,
  getSchemaPath,
  type SchemaObject,
} from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { ResponseMetaDto } from './openapi';

/** Converts a Zod schema to an OpenAPI 3.0 schema, so validation and docs share one source. */
export function toOpenApiSchema(schema: ZodType, io: 'input' | 'output' = 'output'): SchemaObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return json;
}

/** Documents a JSON request body validated by the given Zod schema. */
export function ApiZodBody(schema: ZodType) {
  return ApiBody({ schema: toOpenApiSchema(schema, 'input') });
}

/** Documents query parameters from a Zod object schema. */
export function ApiZodQuery(schema: z.ZodObject) {
  const json = toOpenApiSchema(schema, 'input');
  const required = new Set(json.required ?? []);
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) =>
      ApiQuery({ name, required: required.has(name), schema: property as SchemaObject }),
    ),
  );
}

/** Documents a success response whose `data` matches the given Zod schema. */
export function ApiZodResponse(schema: ZodType, status = 200) {
  return applyDecorators(
    ApiExtraModels(ResponseMetaDto),
    ApiResponse({
      status,
      schema: {
        type: 'object',
        required: ['success', 'data', 'meta'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: toOpenApiSchema(schema),
          meta: { $ref: getSchemaPath(ResponseMetaDto) },
        },
      },
    }),
  );
}

/** Documents a paginated response whose items match the given Zod schema. */
export function ApiZodPaginatedResponse(item: ZodType) {
  return ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['success', 'data', 'meta'],
      properties: {
        success: { type: 'boolean', enum: [true] },
        data: { type: 'array', items: toOpenApiSchema(item) },
        meta: {
          type: 'object',
          required: ['page', 'limit', 'total', 'totalPages', 'requestId'],
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
            requestId: { type: 'string' },
          },
        },
      },
    },
  });
}
