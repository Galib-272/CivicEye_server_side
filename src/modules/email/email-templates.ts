import type { PreferredLocale } from '../../generated/prisma/enums';

export type EmailTemplate =
  | { name: 'verify-email'; link: string }
  | { name: 'reset-password'; link: string }
  | { name: 'password-changed' }
  | { name: 'registration-attempt'; signInLink: string; resetLink: string };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: string;
  greeting: (name: string) => string;
  paragraphs: string[];
  action?: { label: string; link: string };
  footer: string;
}

const FOOTER = {
  en: 'If you did not expect this email, you can ignore it. — CivicEye',
  bn: 'আপনি যদি এই ইমেইলটি আশা না করে থাকেন, তাহলে এটি উপেক্ষা করতে পারেন। — সিভিকআই',
};

// Subjects are generic (PRD §9.3): they never contain account or report details.
function copyFor(template: EmailTemplate, locale: PreferredLocale): Copy {
  const bn = locale === 'bn';
  switch (template.name) {
    case 'verify-email':
      return {
        subject: bn ? 'আপনার সিভিকআই ইমেইল যাচাই করুন' : 'Verify your CivicEye email address',
        greeting: (name) => (bn ? `প্রিয় ${name},` : `Hello ${name},`),
        paragraphs: [
          bn
            ? 'আপনার ইমেইল ঠিকানা যাচাই করতে নিচের লিংকে ক্লিক করুন। লিংকটি ২৪ ঘণ্টা কার্যকর থাকবে।'
            : 'Please confirm your email address using the link below. The link is valid for 24 hours.',
        ],
        action: { label: bn ? 'ইমেইল যাচাই করুন' : 'Verify email address', link: template.link },
        footer: bn ? FOOTER.bn : FOOTER.en,
      };
    case 'reset-password':
      return {
        subject: bn ? 'আপনার সিভিকআই পাসওয়ার্ড রিসেট' : 'Reset your CivicEye password',
        greeting: (name) => (bn ? `প্রিয় ${name},` : `Hello ${name},`),
        paragraphs: [
          bn
            ? 'নতুন পাসওয়ার্ড নির্ধারণ করতে নিচের লিংকে ক্লিক করুন। লিংকটি ৩০ মিনিট কার্যকর থাকবে এবং একবারই ব্যবহার করা যাবে।'
            : 'Use the link below to choose a new password. The link is valid for 30 minutes and can be used once.',
        ],
        action: { label: bn ? 'পাসওয়ার্ড রিসেট করুন' : 'Reset password', link: template.link },
        footer: bn ? FOOTER.bn : FOOTER.en,
      };
    case 'password-changed':
      return {
        subject: bn
          ? 'আপনার সিভিকআই পাসওয়ার্ড পরিবর্তন হয়েছে'
          : 'Your CivicEye password was changed',
        greeting: (name) => (bn ? `প্রিয় ${name},` : `Hello ${name},`),
        paragraphs: [
          bn
            ? 'আপনার অ্যাকাউন্টের পাসওয়ার্ড পরিবর্তন করা হয়েছে এবং অন্যান্য ডিভাইস থেকে সাইন আউট করা হয়েছে।'
            : 'The password for your account was changed and other devices were signed out.',
          bn
            ? 'আপনি এই পরিবর্তন না করে থাকলে এখনই পাসওয়ার্ড রিসেট করুন এবং সহায়তার সঙ্গে যোগাযোগ করুন।'
            : 'If you did not make this change, reset your password now and contact support.',
        ],
        footer: bn ? FOOTER.bn : FOOTER.en,
      };
    case 'registration-attempt':
      return {
        subject: bn ? 'সিভিকআই অ্যাকাউন্ট সংক্রান্ত তথ্য' : 'About your CivicEye account',
        greeting: (name) => (bn ? `প্রিয় ${name},` : `Hello ${name},`),
        paragraphs: [
          bn
            ? 'কেউ এই ইমেইল ঠিকানা দিয়ে নতুন সিভিকআই অ্যাকাউন্ট খোলার চেষ্টা করেছে। এই ঠিকানায় ইতিমধ্যে একটি অ্যাকাউন্ট আছে।'
            : 'Someone tried to create a CivicEye account with this email address. An account already exists for it.',
          bn
            ? `আপনি সাইন ইন করতে পারেন (${template.signInLink}) অথবা পাসওয়ার্ড ভুলে গেলে রিসেট করতে পারেন (${template.resetLink})।`
            : `You can sign in (${template.signInLink}) or, if you forgot your password, reset it (${template.resetLink}).`,
        ],
        footer: bn ? FOOTER.bn : FOOTER.en,
      };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmail(
  template: EmailTemplate,
  locale: PreferredLocale,
  recipientName: string,
): RenderedEmail {
  const copy = copyFor(template, locale);
  const greeting = copy.greeting(recipientName);

  const text = [
    greeting,
    '',
    ...copy.paragraphs.flatMap((paragraph) => [paragraph, '']),
    ...(copy.action ? [`${copy.action.label}: ${copy.action.link}`, ''] : []),
    copy.footer,
  ].join('\n');

  const html = `<!doctype html>
<html lang="${locale}">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #14171a;">
  <p>${escapeHtml(greeting)}</p>
  ${copy.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n  ')}
  ${
    copy.action
      ? `<p><a href="${escapeHtml(copy.action.link)}" style="display:inline-block;padding:10px 16px;background:#0b5cad;color:#ffffff;border-radius:6px;text-decoration:none;">${escapeHtml(copy.action.label)}</a></p>
  <p style="font-size: 13px; color: #4a5560;">${escapeHtml(copy.action.link)}</p>`
      : ''
  }
  <p style="font-size: 13px; color: #4a5560;">${escapeHtml(copy.footer)}</p>
</body>
</html>`;

  return { subject: copy.subject, text, html };
}
