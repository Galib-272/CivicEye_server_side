import { randomBytes } from 'node:crypto';
import {
  constantTimeEquals,
  decryptSecret,
  encryptSecret,
  generateToken,
  sha256Hex,
} from './crypto';

describe('auth crypto helpers', () => {
  const key = randomBytes(32);

  it('generates unique URL-safe tokens with 256 bits of entropy', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex characters', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('round-trips secrets and uses a fresh IV each time', () => {
    const first = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const second = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(first).not.toBe(second);
    expect(first).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(first, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects tampered ciphertext and the wrong key', () => {
    const payload = encryptSecret('secret', key);
    const parts = payload.split('.');
    const tampered = [...parts.slice(0, 3), Buffer.from('XXXXXX').toString('base64url')].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow();
    expect(() => decryptSecret('v0.a.b.c', key)).toThrow(/Unsupported/);
  });

  it('compares strings without short-circuiting on length mismatch', () => {
    expect(constantTimeEquals('token', 'token')).toBe(true);
    expect(constantTimeEquals('token', 'tokem')).toBe(false);
    expect(constantTimeEquals('token', 'token-longer')).toBe(false);
  });
});
