/**
 * Approved password policy (Phase 2): 12–128 characters, no composition rules, and not a
 * well-known or easily guessed password (NIST SP 800-63B).
 *
 * The blocklist is a built-in set of common passwords that meet the length rule, plus pattern
 * checks. It can be replaced with a larger breached-password list later.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordIssue =
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_LONG'
  | 'PASSWORD_TOO_COMMON'
  | 'PASSWORD_CONTAINS_PERSONAL_INFO';

const COMMON_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789123',
  '111111111111',
  '000000000000',
  '123123123123',
  '121212121212',
  '987654321098',
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  'password@123',
  'p@ssw0rd1234',
  'qwertyuiopasdf',
  'qwertyuiop12',
  'qwerty123456',
  'qwertyqwerty',
  'qwerty12345678',
  'asdfghjkl123',
  'asdfasdfasdf',
  'zxcvbnm12345',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'qazwsxedcrfv',
  'abcdefghijkl',
  'abc123abc123',
  'iloveyou1234',
  'iloveyouiloveyou',
  'letmein12345',
  'welcome12345',
  'welcome@1234',
  'admin1234567',
  'administrator',
  'changeme1234',
  'trustno11234',
  'monkey123456',
  'dragon123456',
  'football1234',
  'baseball1234',
  'sunshine1234',
  'princess1234',
  'starwars1234',
  'superman1234',
  'bangladesh123',
  'bangladesh1234',
  'bangladesh@123',
  'dhaka1234567',
  'civiceye1234',
  'civiceye12345',
]);

const SEQUENCES = [
  '01234567890123456789012345',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
];

function isRepeatedPattern(value: string): boolean {
  // "aaaaaaaaaaaa", "abcabcabcabc", "1212121212121" and similar.
  for (let size = 1; size <= 4; size += 1) {
    const unit = value.slice(0, size);
    if (unit.repeat(Math.ceil(value.length / size)).startsWith(value)) {
      return true;
    }
  }
  return false;
}

function isSequence(value: string): boolean {
  return SEQUENCES.some(
    (sequence) => sequence.includes(value) || [...sequence].reverse().join('').includes(value),
  );
}

export function checkPasswordPolicy(
  password: string,
  personal: { email?: string; name?: string } = {},
): PasswordIssue[] {
  // Count user-perceived characters (code points), so Bangla and emoji are measured fairly.
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return ['PASSWORD_TOO_SHORT'];
  if (length > PASSWORD_MAX_LENGTH) return ['PASSWORD_TOO_LONG'];

  const normalized = password.toLowerCase().normalize('NFKC');
  const issues: PasswordIssue[] = [];

  if (COMMON_PASSWORDS.has(normalized) || isRepeatedPattern(normalized) || isSequence(normalized)) {
    issues.push('PASSWORD_TOO_COMMON');
  }

  const emailLocal = personal.email?.split('@')[0]?.toLowerCase();
  const nameParts = (personal.name ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 4);
  const personalTerms = [emailLocal, ...nameParts].filter(
    (term): term is string => !!term && term.length >= 4,
  );
  if (personalTerms.some((term) => normalized.includes(term))) {
    issues.push('PASSWORD_CONTAINS_PERSONAL_INFO');
  }

  return issues;
}

export const PASSWORD_ISSUE_MESSAGES: Record<PasswordIssue, string> = {
  PASSWORD_TOO_SHORT: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  PASSWORD_TOO_LONG: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  PASSWORD_TOO_COMMON: 'This password is too common or easy to guess.',
  PASSWORD_CONTAINS_PERSONAL_INFO: 'Do not include your name or email address in your password.',
};
