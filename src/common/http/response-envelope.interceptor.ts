import {
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { map, type Observable } from 'rxjs';
import { Paginated, type ApiPaginated, type ApiSuccess } from './api-response';
import { getRequestId } from './request-id';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccess<unknown> | ApiPaginated<unknown> | StreamableFile> {
    const requestId = getRequestId(context.switchToHttp().getRequest<Request>());

    return next.handle().pipe(
      map((body: unknown) => {
        if (body instanceof StreamableFile) {
          return body;
        }
        if (body instanceof Paginated) {
          return { success: true, data: body.items, meta: { ...body.meta, requestId } };
        }
        return { success: true, data: body ?? null, meta: { requestId } };
      }),
    );
  }
}
