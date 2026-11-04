import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AppException } from './app-exception';
import { ErrorCode } from './error-codes';
import { HttpExceptionFilter } from './http-exception.filter';

function run(exception: unknown) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-12345678' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);

  const [status] = response.status.mock.calls[0] as [number];
  const [body] = response.json.mock.calls[0] as [Record<string, unknown>];
  return { status, body };
}

describe('HttpExceptionFilter', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns AppException code, message and details verbatim', () => {
    const { status, body } = run(
      new AppException(ErrorCode.INVALID_STATE_TRANSITION, 'Cannot resolve a submitted report.', [
        { field: 'status', message: 'Invalid transition' },
      ]),
    );
    expect(status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INVALID_STATE_TRANSITION',
        message: 'Cannot resolve a submitted report.',
        details: [{ field: 'status', message: 'Invalid transition' }],
        requestId: 'req-12345678',
      },
    });
  });

  it.each([
    [new BadRequestException('raw framework text'), 400, 'VALIDATION_ERROR'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new NotFoundException('Cannot GET /api/v1/internal-thing'), 404, 'NOT_FOUND'],
    [new ThrottlerException(), 429, 'RATE_LIMITED'],
    [new HttpException('x', HttpStatus.METHOD_NOT_ALLOWED), 405, 'NOT_FOUND'],
  ])('maps %p to a stable code with a safe default message', (exception, status, code) => {
    const result = run(exception);
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ success: false, error: { code } });
    expect(JSON.stringify(result.body)).not.toContain('raw framework text');
    expect(JSON.stringify(result.body)).not.toContain('/api/v1/internal-thing');
  });

  it('hides unexpected errors behind INTERNAL_ERROR and logs them', () => {
    const error = new Error('relation "users" does not exist at 10.0.0.12:5432');
    const { status, body } = run(error);

    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        details: [],
        requestId: 'req-12345678',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/relation|10\.0\.0\.12|stack/);
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
  });

  it('treats non-error throwables as internal errors', () => {
    expect(run('a string').body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('maps exposed body-parser errors by status', () => {
    const parseError = Object.assign(new SyntaxError('Unexpected token b in JSON'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });

    expect(run(parseError)).toMatchObject({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(run(tooLarge)).toMatchObject({
      status: 413,
      body: { error: { code: 'FILE_TOO_LARGE', message: 'The request is too large.' } },
    });
    expect(JSON.stringify(run(parseError).body)).not.toContain('Unexpected token');
  });

  it('does not trust status codes on errors that are not marked as exposable', () => {
    const internal = Object.assign(new Error('upstream'), { status: 404 });
    expect(run(internal)).toMatchObject({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR' } },
    });
  });
});
