/**
 * Creates a Super Admin account from the command line. There is no public way to become an
 * administrator; this command requires direct access to the server environment and database.
 *
 * Usage:  npm run admin:create
 *         npm run admin:create -- --promote-existing   (make an existing account a Super Admin)
 *
 * The password is read from a hidden prompt (never from arguments, which end up in shell history).
 * Two-factor setup is enforced on the account's first sign-in.
 */
import 'reflect-metadata';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { loadConfig } from '../src/config/app-config';
import { PrismaService } from '../src/database/prisma.service';
import { PasswordService } from '../src/modules/auth/password.service';

loadDotenv({ quiet: true });

async function prompt(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: true });
  const answerPromise = rl.question(question);
  muted = hidden;
  const answer = await answerPromise;
  rl.close();
  if (hidden) stdout.write('\n');
  return answer.trim();
}

async function main(): Promise<void> {
  const promoteExisting = process.argv.includes('--promote-existing');
  const config = loadConfig();
  const prisma = new PrismaService(config);
  const passwords = new PasswordService();

  try {
    const email = z
      .email()
      .transform((value) => value.toLowerCase())
      .parse(await prompt('Admin email: '));
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, platformRole: true, status: true },
    });

    if (existing) {
      if (!promoteExisting) {
        throw new Error(
          'An account with this email already exists. Re-run with --promote-existing to make it a Super Admin.',
        );
      }
      if (existing.status !== 'ACTIVE') {
        throw new Error(`Only ACTIVE accounts can be promoted (this one is ${existing.status}).`);
      }
      await prisma.$transaction([
        prisma.user.update({ where: { id: existing.id }, data: { platformRole: 'SUPER_ADMIN' } }),
        prisma.auditLog.create({
          data: {
            action: 'admin.promoted',
            result: 'SUCCESS',
            targetType: 'user',
            targetId: existing.id,
            metadata: { source: 'cli', from: existing.platformRole },
          },
        }),
      ]);
      stdout.write(
        'Account promoted to Super Admin. Two-factor setup is required at next sign-in.\n',
      );
      return;
    }

    const name = z
      .string()
      .trim()
      .min(1)
      .max(100)
      .parse(await prompt('Admin name: '));
    const password = await prompt('Password (hidden): ', true);
    passwords.assertAcceptable(password, { email, name });
    if (password !== (await prompt('Repeat password (hidden): ', true))) {
      throw new Error('Passwords do not match.');
    }

    const passwordHash = await passwords.hash(password);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          platformRole: 'SUPER_ADMIN',
          status: 'ACTIVE',
          // The operator running this command vouches for the address.
          emailVerifiedAt: now,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          action: 'admin.created',
          result: 'SUCCESS',
          targetType: 'user',
          targetId: user.id,
          metadata: { source: 'cli' },
        },
      });
    });
    stdout.write('Super Admin created. Two-factor setup is required at first sign-in.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const details =
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join('; ')
      : error instanceof Error && 'details' in error
        ? JSON.stringify((error as { details: unknown }).details)
        : error instanceof Error
          ? error.message
          : String(error);
  process.stderr.write(`Could not create the admin account: ${details}\n`);
  process.exit(1);
});
