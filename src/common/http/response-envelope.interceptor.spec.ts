import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { Paginated } from './api-response';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function intercept(body: unknown) {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-abcdefgh' }) }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(body) };
  return lastValueFrom(new ResponseEnvelopeInterceptor().intercept(context, next));
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps plain values in the success envelope', async () => {
    await expect(intercept({ id: 'r1', status: 'SUBMITTED' })).resolves.toEqual({
      success: true,
      data: { id: 'r1', status: 'SUBMITTED' },
      meta: { requestId: 'req-abcdefgh' },
    });
  });

  it('returns null data for empty bodies', async () => {
    await expect(intercept(undefined)).resolves.toEqual({
      success: true,
      data: null,
      meta: { requestId: 'req-abcdefgh' },
    });
  });

  it('produces the paginated envelope for Paginated results', async () => {
    await expect(
      intercept(new Paginated(['a', 'b'], { page: 2, limit: 2, total: 5 })),
    ).resolves.toEqual({
      success: true,
      data: ['a', 'b'],
      meta: { page: 2, limit: 2, total: 5, totalPages: 3, requestId: 'req-abcdefgh' },
    });
  });

  it('reports zero pages for empty results', async () => {
    await expect(
      intercept(new Paginated([], { page: 1, limit: 20, total: 0 })),
    ).resolves.toMatchObject({
      data: [],
      meta: { total: 0, totalPages: 0 },
    });
  });

  it('passes file streams through unchanged', async () => {
    const file = new StreamableFile(Buffer.from('x'));
    await expect(intercept(file)).resolves.toBe(file);
  });
});
