import { HttpStatus } from '@nestjs/common';

/**
 * Stable, client-facing error codes (PRD §14.15). Codes are part of the API contract:
 * add new ones freely, but never rename or repurpose an existing code.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  DUPLICATE_SUBMISSION: 'DUPLICATE_SUBMISSION',
  RATE_LIMITED: 'RATE_LIMITED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  ORGANIZATION_NOT_ELIGIBLE: 'ORGANIZATION_NOT_ELIGIBLE',
  ASSIGNMENT_NOT_FOUND: 'ASSIGNMENT_NOT_FOUND',
  AI_SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  INVALID_MFA_CODE: 'INVALID_MFA_CODE',
  MFA_REQUIRED: 'MFA_REQUIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default HTTP status and safe public message for each code. */
export const errorCodeDefaults: Record<ErrorCode, { status: HttpStatus; message: string }> = {
  VALIDATION_ERROR: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The submitted information is invalid.',
  },
  UNAUTHENTICATED: { status: HttpStatus.UNAUTHORIZED, message: 'Authentication is required.' },
  FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    message: 'You do not have permission to perform this action.',
  },
  NOT_FOUND: { status: HttpStatus.NOT_FOUND, message: 'The requested resource was not found.' },
  CONFLICT: {
    status: HttpStatus.CONFLICT,
    message: 'The resource was changed by another request.',
  },
  INVALID_STATE_TRANSITION: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This action is not allowed in the current state.',
  },
  DUPLICATE_SUBMISSION: {
    status: HttpStatus.CONFLICT,
    message: 'This request was already submitted.',
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many requests. Please try again later.',
  },
  FILE_TOO_LARGE: { status: HttpStatus.PAYLOAD_TOO_LARGE, message: 'The file is too large.' },
  UNSUPPORTED_FILE_TYPE: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'This file type is not supported.',
  },
  ORGANIZATION_NOT_ELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'The organization is not eligible for this action.',
  },
  ASSIGNMENT_NOT_FOUND: { status: HttpStatus.NOT_FOUND, message: 'The assignment was not found.' },
  AI_SERVICE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The analysis service is temporarily unavailable.',
  },
  SERVICE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The service is temporarily unavailable.',
  },
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'An unexpected error occurred.',
  },
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'The email or password is incorrect.',
  },
  INVALID_TOKEN: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This link is invalid or has expired.',
  },
  INVALID_MFA_CODE: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The verification code is incorrect.',
  },
  MFA_REQUIRED: {
    status: HttpStatus.FORBIDDEN,
    message: 'Two-factor verification is required to continue.',
  },
  EMAIL_NOT_VERIFIED: {
    status: HttpStatus.FORBIDDEN,
    message: 'Please verify your email address first.',
  },
  ACCOUNT_INACTIVE: {
    status: HttpStatus.FORBIDDEN,
    message: 'This account cannot sign in. Please contact support.',
  },
  CSRF_TOKEN_INVALID: {
    status: HttpStatus.FORBIDDEN,
    message: 'The request could not be verified. Please reload the page and try again.',
  },
  PRECONDITION_REQUIRED: {
    status: HttpStatus.PRECONDITION_REQUIRED,
    message: 'Send the If-Match header with the version you are changing.',
  },
};
