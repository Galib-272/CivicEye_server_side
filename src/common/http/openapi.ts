import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ErrorCode } from '../errors/error-codes';

export class ResponseMetaDto {
  @ApiProperty()
  requestId!: string;
}

export class ErrorDetailDto {
  @ApiProperty({ required: false })
  field?: string;

  @ApiProperty()
  message!: string;
}

export class ErrorBodyDto {
  @ApiProperty({ enum: Object.values(ErrorCode), enumName: 'ErrorCode' })
  code!: ErrorCode;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: [ErrorDetailDto] })
  details!: ErrorDetailDto[];

  @ApiProperty()
  requestId!: string;
}

export class ApiErrorDto {
  @ApiProperty({ enum: [false] })
  success!: false;

  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}

/** Documents a 200 response wrapped in the standard success envelope. */
export function ApiEnvelopeResponse(model: Type<unknown>, status = 200) {
  return applyDecorators(
    ApiExtraModels(model, ResponseMetaDto),
    ApiResponse({
      status,
      schema: {
        type: 'object',
        required: ['success', 'data', 'meta'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: { $ref: getSchemaPath(model) },
          meta: { $ref: getSchemaPath(ResponseMetaDto) },
        },
      },
    }),
  );
}

/** Documents error responses that use the standard error envelope. */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(
    ApiExtraModels(ApiErrorDto),
    ...statuses.map((status) => ApiResponse({ status, type: ApiErrorDto })),
  );
}
