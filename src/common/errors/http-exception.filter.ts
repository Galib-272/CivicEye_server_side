import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiError } from '../http/api-response';
import { getRequestId } from '../http/request-id';
import { AppException, type ErrorDetail } from './app-exception';
import { ErrorCode, errorCodeDefaults } from './error-codes';

interface NormalizedError {
  status: number;
  code: ErrorCode;
  message: string;
  details: ErrorDetail[];
}

const statusToCode: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.FILE_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCode.UNSUPPORTED_FILE_TYPE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

/** Errors raised by Express middleware (e.g. body-parser) carry a status but are not HttpExceptions. */
function middlewareStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode, expose } = error as Record<string, unknown>;
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && expose === true && value >= 400 && value < 500
    ? value
    : undefined;
}

/**
 * Converts every thrown value into the PRD error envelope. Only AppException messages reach
 * the client verbatim; everything else gets the safe default message for its code, so stack
 * traces, SQL errors and internal addresses are never exposed.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = getRequestId(request);
    const normalized = this.normalize(exception);

    // Deliberate AppExceptions (e.g. readiness 503) are logged where they are raised.
    if (normalized.status >= 500 && !(exception instanceof AppException)) {
      this.logger.error(
        { err: exception, requestId, code: normalized.code },
        'Request failed with an unexpected error',
      );
    }

    const { status, ...error } = normalized;
    const body: ApiError = { success: false, error: { ...error, requestId } };

    response.status(status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    const status: number | undefined =
      exception instanceof HttpException ? exception.getStatus() : middlewareStatus(exception);

    if (status === undefined || status >= 500) {
      const code =
        status === Number(HttpStatus.SERVICE_UNAVAILABLE)
          ? ErrorCode.SERVICE_UNAVAILABLE
          : ErrorCode.INTERNAL_ERROR;
      return {
        status: status ?? HttpStatus.INTERNAL_SERVER_ERROR,
        code,
        message: errorCodeDefaults[code].message,
        details: [],
      };
    }

    const code = statusToCode[status] ?? ErrorCode.VALIDATION_ERROR;
    const message =
      status === Number(HttpStatus.PAYLOAD_TOO_LARGE)
        ? 'The request is too large.'
        : errorCodeDefaults[code].message;
    return { status, code, message, details: [] };
  }
}
