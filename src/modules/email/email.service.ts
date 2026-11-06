import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import type { PreferredLocale } from '../../generated/prisma/enums';
import { renderEmail, type EmailTemplate, type RenderedEmail } from './email-templates';

export interface EmailMessage extends RenderedEmail {
  to: string;
}

/** Delivery backend: SMTP (Mailpit in development) or Resend (staging/production). */
export interface EmailTransport {
  send(from: string, message: EmailMessage): Promise<void>;
}

class SmtpTransport implements EmailTransport {
  private readonly transporter: Transporter;

  constructor(url: string) {
    this.transporter = createTransport(url);
  }

  async send(from: string, message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from, ...message });
  }
}

class ResendTransport implements EmailTransport {
  private readonly client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(from: string, message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({ from, ...message });
    if (error) {
      throw new Error(`Resend rejected the message: ${error.name}`);
    }
  }
}

export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** Waits before retrying an account email; after the last one it is logged as failed. */
export const ACCOUNT_EMAIL_RETRY_DELAYS_MS = [2_000, 10_000] as const;

export function createEmailTransport(config: AppConfig): EmailTransport {
  return config.email.provider === 'resend'
    ? new ResendTransport(config.email.resendApiKey)
    : new SmtpTransport(config.email.smtpUrl);
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
  ) {}

  /** Builds a link into the web app. Secret tokens go in the fragment, which browsers never send to servers. */
  webLink(locale: PreferredLocale, path: string, fragment?: Record<string, string>): string {
    const url = new URL(`/${locale}${path}`, this.config.webUrl);
    if (fragment) url.hash = new URLSearchParams(fragment).toString();
    return url.toString();
  }

  /** Renders and sends one email, throwing if the provider refuses it. */
  async send(
    recipient: { email: string; name: string; preferredLocale: PreferredLocale },
    template: EmailTemplate,
  ): Promise<void> {
    const rendered = renderEmail(template, recipient.preferredLocale, recipient.name);
    await this.transport.send(this.config.email.from, { to: recipient.email, ...rendered });
  }

  /**
   * Sends in the background and never throws: a failed email must not undo or fail the action
   * that triggered it. Transient failures are retried in this process (after 2 s and 10 s), so
   * one-time links in account emails are never written to a queue or the database.
   */
  sendInBackground(
    recipient: { email: string; name: string; preferredLocale: PreferredLocale },
    template: EmailTemplate,
  ): void {
    void this.sendWithRetry(recipient, template, ACCOUNT_EMAIL_RETRY_DELAYS_MS);
  }

  private async sendWithRetry(
    recipient: { email: string; name: string; preferredLocale: PreferredLocale },
    template: EmailTemplate,
    delays: readonly number[],
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.send(recipient, template);
        return;
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined) {
          // The address is personal data; log the template only.
          this.logger.error(
            { err: error, template: template.name, attempts: attempt + 1 },
            'Email delivery failed',
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
