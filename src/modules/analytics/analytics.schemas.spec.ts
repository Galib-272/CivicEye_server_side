import { dhakaToday, RangeTooLongError, resolveRange } from './analytics.schemas';

describe('dashboard date ranges (Bangladesh time)', () => {
  // 2026-11-07 20:30 UTC is already 2026-11-08 02:30 in Dhaka.
  const now = new Date('2026-11-07T20:30:00Z');

  it('uses the Bangladesh date for today', () => {
    expect(dhakaToday(now)).toBe('2026-11-08');
  });

  it('defaults to the last 30 days, today included', () => {
    const range = resolveRange({}, now);
    expect(range).toMatchObject({ from: '2026-10-10', to: '2026-11-08' });
    expect(range.start.toISOString()).toBe('2026-10-09T18:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-08T18:00:00.000Z');
  });

  it('covers whole Bangladesh days', () => {
    const range = resolveRange({ from: '2026-11-01', to: '2026-11-01' });
    expect(range.start.toISOString()).toBe('2026-10-31T18:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-01T18:00:00.000Z');
  });

  it('refuses ranges longer than 366 days', () => {
    expect(() => resolveRange({ from: '2025-01-01', to: '2026-01-02' })).toThrow(RangeTooLongError);
    expect(() => resolveRange({ from: '2025-01-01', to: '2026-01-01' })).not.toThrow();
  });
});
