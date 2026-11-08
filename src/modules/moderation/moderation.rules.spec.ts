import { allowedActions, nextStatus } from './moderation.service';

const report = {
  targetType: 'REPORT' as const,
  reportHidden: false,
  updateHidden: null,
  citizenStatus: 'ACTIVE',
  citizenIsSuperAdmin: false,
};

describe('moderation rules (PRD §28.2)', () => {
  it('offers every report action on a new case', () => {
    expect(allowedActions({ ...report, status: 'OPEN' })).toEqual([
      'START_REVIEW',
      'HIDE_REPORT',
      'REQUEST_CORRECTION',
      'WARN_USER',
      'SUSPEND_USER',
      'RESOLVE',
      'DISMISS',
    ]);
  });

  it('never offers suspending a Super Admin or an already suspended account', () => {
    expect(
      allowedActions({ ...report, status: 'UNDER_REVIEW', citizenIsSuperAdmin: true }),
    ).not.toContain('SUSPEND_USER');
    expect(
      allowedActions({ ...report, status: 'UNDER_REVIEW', citizenStatus: 'SUSPENDED' }),
    ).not.toContain('SUSPEND_USER');
  });

  it('allows only restoring after a case closes', () => {
    expect(allowedActions({ ...report, status: 'RESOLVED' })).toEqual([]);
    expect(allowedActions({ ...report, status: 'DISMISSED', reportHidden: true })).toEqual([
      'RESTORE_REPORT',
    ]);
  });

  it('offers only hiding for a public update', () => {
    expect(
      allowedActions({
        ...report,
        targetType: 'PUBLIC_UPDATE',
        updateHidden: false,
        status: 'UNDER_REVIEW',
      }),
    ).toEqual(['HIDE_UPDATE', 'RESOLVE', 'DISMISS']);
  });

  it.each([
    ['OPEN', 'START_REVIEW', 'UNDER_REVIEW'],
    ['OPEN', 'HIDE_REPORT', 'UNDER_REVIEW'],
    ['UNDER_REVIEW', 'REQUEST_CORRECTION', 'ACTION_REQUIRED'],
    ['ACTION_REQUIRED', 'WARN_USER', 'ACTION_REQUIRED'],
    ['ACTION_REQUIRED', 'RESOLVE', 'RESOLVED'],
    ['OPEN', 'DISMISS', 'DISMISSED'],
    ['RESOLVED', 'RESTORE_REPORT', 'RESOLVED'],
  ] as const)('%s + %s → %s', (from, kind, to) => {
    expect(nextStatus(from, kind)).toBe(to);
  });
});
