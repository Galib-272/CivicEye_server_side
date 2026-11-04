import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { checkPasswordPolicy, PASSWORD_ISSUE_MESSAGES } from './password-policy';

// OWASP Password Storage Cheat Sheet minimum for Argon2id: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real verification when no account matches, so response timing
   * does not reveal whether an email address is registered.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('civiceye-timing-equalizer-not-a-real-password');
    await this.verify(await this.dummyHash, password);
    return false;
  }

  /** Throws VALIDATION_ERROR with machine-readable issue codes if the policy is not met. */
  assertAcceptable(
    password: string,
    personal: { email?: string; name?: string },
    field = 'password',
  ): void {
    const issues = checkPasswordPolicy(password, personal);
    if (issues.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        undefined,
        issues.map((issue) => ({ field, code: issue, message: PASSWORD_ISSUE_MESSAGES[issue] })),
      );
    }
  }
}
