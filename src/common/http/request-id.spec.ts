import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resolve(headerValue?: string | string[], existingId?: string) {
  const req = {
    headers: { [REQUEST_ID_HEADER]: headerValue },
    id: existingId,
  } as unknown as IncomingMessage;
  const setHeader = jest.fn();
  const id = resolveRequestId(req, { setHeader } as unknown as ServerResponse);
  return { id, setHeader };
}

describe('resolveRequestId', () => {
  it('generates a UUID when no header is supplied and echoes it', () => {
    const { id, setHeader } = resolve();
    expect(id).toMatch(UUID);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, id);
  });

  it('reuses a safe incoming request ID', () => {
    expect(resolve('lb-trace_0123456789').id).toBe('lb-trace_0123456789');
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['unsafe characters', 'abc\r\nSet-Cookie: x=1'],
    ['log injection', '<script>alert(1)</script>'],
  ])('replaces an incoming ID that is %s', (_label, value) => {
    expect(resolve(value).id).toMatch(UUID);
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolve(['first-id-123', 'second-id-456']).id).toBe('first-id-123');
  });

  it('keeps an ID already assigned earlier in the pipeline', () => {
    const { id, setHeader } = resolve('ignored-header-id', 'assigned-id-1234');
    expect(id).toBe('assigned-id-1234');
    expect(setHeader).not.toHaveBeenCalled();
  });
});
