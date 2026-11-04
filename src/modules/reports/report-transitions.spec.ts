import { REPORT_STATUSES } from './reports.schemas';
import { canTransition, EDITABLE_STATUSES, type TransitionActor } from './report-transitions';

const ACTORS: TransitionActor[] = [
  'owner',
  'super_admin',
  'org_reviewer',
  'assigned_worker',
  'system',
];

describe('report transition rules', () => {
  // Exhaustive: every status × every actor for the withdraw transition.
  it.each(REPORT_STATUSES.flatMap((status) => ACTORS.map((actor) => [status, actor] as const)))(
    'withdraw from %s by %s follows the approved policy',
    (status, actor) => {
      const expected =
        actor === 'owner' && (status === 'SUBMITTED' || status === 'NEEDS_INFORMATION');
      expect(canTransition('withdraw', status, actor)).toBe(expected);
    },
  );

  it('allows citizen edits only while SUBMITTED', () => {
    expect([...EDITABLE_STATUSES]).toEqual(['SUBMITTED']);
  });
});
