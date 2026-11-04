import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Backend validation convention: every body, query and path parameter is parsed with a Zod
 * schema, e.g. `@Body(new ZodValidationPipe(createReportSchema)) dto: CreateReportDto`.
 * Unknown keys are rejected by using `z.strictObject` in the schema itself.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        undefined,
        result.error.issues.map((issue) => ({
          field: issue.path.join('.') || undefined,
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
