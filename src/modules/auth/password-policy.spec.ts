import { checkPasswordPolicy } from './password-policy';

describe('checkPasswordPolicy', () => {
  it('accepts a long passphrase with no composition rules', () => {
    expect(checkPasswordPolicy('correct horse battery staple')).toEqual([]);
    expect(checkPasswordPolicy('alllowercaseletters')).toEqual([]);
  });

  it('enforces the 12–128 character range, counting characters not bytes', () => {
    expect(checkPasswordPolicy('short-pass1')).toEqual(['PASSWORD_TOO_SHORT']);
    expect(checkPasswordPolicy('a'.repeat(129) + 'x')).toEqual(['PASSWORD_TOO_LONG']);
    // 12 Bangla characters are accepted even though they occupy more than 12 bytes.
    expect(checkPasswordPolicy('আমার সোনার বাংলা')).toEqual([]);
    expect(checkPasswordPolicy('বাংলাদেশ')).toEqual(['PASSWORD_TOO_SHORT']);
  });

  it.each([
    'password1234',
    'Password1234',
    'bangladesh123',
    '123456789012',
    'aaaaaaaaaaaaaa',
    'abcabcabcabcabc',
    'abcdefghijklmn',
    'qwertyuiopasdf',
    '0123456789012',
  ])('rejects the common or patterned password %p', (password) => {
    expect(checkPasswordPolicy(password)).toContain('PASSWORD_TOO_COMMON');
  });

  it('rejects passwords containing the email name or a name part', () => {
    expect(checkPasswordPolicy('rahima-secure-2026', { email: 'rahima@example.test' })).toEqual([
      'PASSWORD_CONTAINS_PERSONAL_INFO',
    ]);
    expect(
      checkPasswordPolicy('my karim passphrase', { email: 'x@example.test', name: 'Abdul Karim' }),
    ).toEqual(['PASSWORD_CONTAINS_PERSONAL_INFO']);
  });

  it('ignores very short name parts to avoid false positives', () => {
    expect(checkPasswordPolicy('a long passphrase', { name: 'Al Ng' })).toEqual([]);
  });
});
