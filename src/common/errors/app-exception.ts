import { HttpException } from '@nestjs/common';
import { errorCodeDefaults, type ErrorCode } from './error-codes';

export interface ErrorDetail {
  field?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * The only exception type business code should throw. Its message and details are
 * returned to the client, so they must never contain internal or private data.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details: ErrorDetail[] = [],
  ) {
    const defaults = errorCodeDefaults[code];
    super(message ?? defaults.message, defaults.status);
  }
}
