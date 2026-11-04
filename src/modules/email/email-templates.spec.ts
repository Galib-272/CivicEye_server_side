import { renderEmail } from './email-templates';

describe('renderEmail', () => {
  const link = 'http://localhost:3000/en/verify-email#token=abc';

  it('renders English and Bangla versions with the action link', () => {
    const en = renderEmail({ name: 'verify-email', link }, 'en', 'Rahima');
    const bn = renderEmail({ name: 'verify-email', link }, 'bn', 'রহিমা');

    expect(en.subject).toBe('Verify your CivicEye email address');
    expect(en.text).toContain('Hello Rahima,');
    expect(en.text).toContain(link);
    expect(bn.subject).toMatch(/[ঀ-৿]/);
    expect(bn.html).toContain('lang="bn"');
  });

  it('keeps subject lines generic (no names or links)', () => {
    for (const template of [
      { name: 'verify-email', link } as const,
      { name: 'reset-password', link } as const,
      { name: 'password-changed' } as const,
      { name: 'registration-attempt', signInLink: link, resetLink: link } as const,
    ]) {
      const { subject } = renderEmail(template, 'en', 'Rahima');
      expect(subject).not.toContain('Rahima');
      expect(subject).not.toContain('http');
    }
  });

  it('escapes user-controlled values in HTML', () => {
    const { html, text } = renderEmail(
      { name: 'password-changed' },
      'en',
      '<script>alert(1)</script>',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(text).toContain('<script>alert(1)</script>');
  });
});
