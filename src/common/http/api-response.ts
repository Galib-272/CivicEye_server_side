import type { ErrorCode } from '../errors/error-codes';
import type { ErrorDetail } from '../errors/app-exception';

/** Response contract shared by every endpoint (PRD §14.14). */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: { requestId: string };
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiPaginated<T> {
  success: true;
  data: T[];
  meta: PaginationMeta & { requestId: string };
}

export interface ApiError {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    requestId: string;
  };
}

/**
 * Return this from a controller to produce a paginated envelope. Plain return values are
 * wrapped as single-item success responses.
 */
export class Paginated<T> {
  readonly meta: PaginationMeta;

  constructor(
    readonly items: T[],
    pagination: { page: number; limit: number; total: number },
  ) {
    this.meta = {
      ...pagination,
      totalPages: pagination.total === 0 ? 0 : Math.ceil(pagination.total / pagination.limit),
    };
  }
}
