import type { AccountStatus, PlatformRole, PreferredLocale } from '../../generated/prisma/enums';
import type { SessionRecord } from './session.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  status: AccountStatus;
  platformRole: PlatformRole;
  preferredLocale: PreferredLocale;
  emailVerifiedAt: Date | null;
}

export interface AuthContext {
  user: AuthenticatedUser;
  session: SessionRecord;
  /** Raw session token from the cookie; needed to rotate or end the current session. */
  token: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  status: true,
  platformRole: true,
  preferredLocale: true,
  emailVerifiedAt: true,
} as const;

/** Account states that may hold a session. */
export const SIGN_IN_ALLOWED_STATUSES: ReadonlySet<AccountStatus> = new Set([
  'PENDING_VERIFICATION',
  'ACTIVE',
]);
