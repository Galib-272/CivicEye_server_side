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

  /**
   * Sends in the background and never throws: a failed email must not undo or fail the action
   * that triggered it, and response time must not depend on whether an email was sent.
   * Reliable delivery with retries arrives with the notification outbox (Phase 7).
   */
  sendInBackground(
    recipient: { email: string; name: string; preferredLocale: PreferredLocale },
    template: EmailTemplate,
  ): void {
    const rendered = renderEmail(template, recipient.preferredLocale, recipient.name);
    void this.transport
      .send(this.config.email.from, { to: recipient.email, ...rendered })
      .catch((error: unknown) =>
        // The address is personal data; log the template only.
        this.logger.error({ err: error, template: template.name }, 'Email delivery failed'),
      );
  }
}
