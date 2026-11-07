import type { NotificationType, PreferredLocale } from '../../generated/prisma/enums';

export type EmailTemplate =
  | { name: 'verify-email'; link: string }
  | { name: 'reset-password'; link: string }
  | { name: 'password-changed' }
  | { name: 'registration-attempt'; signInLink: string; resetLink: string }
  | { name: 'organization-invitation'; organizationName: string; role: string; link: string }
  | { name: 'organization-contact-confirmation'; organizationName: string; link: string }
  | {
      name: 'notification';
      type: NotificationType;
      /** The public report ID only; never the title, description, location or messages. */
      reportPublicId: string | null;
      link: string;
    };

/**
 * One sentence per notification type. Deliberately free of report content: emails can be read
 * on shared devices and in notification previews, so they only say what kind of change happened.
 */
export const NOTIFICATION_SENTENCES: Record<NotificationType, { en: string; bn: string }> = {
  REPORT_UNDER_REVIEW: {
    en: 'The responsible organization started reviewing your report.',
    bn: 'দায়িত্বপ্রাপ্ত প্রতিষ্ঠান আপনার রিপোর্ট পর্যালোচনা শুরু করেছে।',
  },
  INFORMATION_REQUESTED: {
    en: 'The organization needs more information about your report.',
    bn: 'আপনার রিপোর্ট সম্পর্কে প্রতিষ্ঠানের আরও তথ্য প্রয়োজন।',
  },
  REPORT_ACCEPTED: {
    en: 'Your report was accepted.',
    bn: 'আপনার রিপোর্ট গৃহীত হয়েছে।',
  },
  REPORT_REJECTED: {
    en: 'Your report was not accepted. The reason is on the report page.',
    bn: 'আপনার রিপোর্ট গৃহীত হয়নি। কারণ রিপোর্টের পাতায় দেখুন।',
  },
  REPORT_TRANSFERRED: {
    en: 'Your report was moved to another organization.',
    bn: 'আপনার রিপোর্ট অন্য একটি প্রতিষ্ঠানে পাঠানো হয়েছে।',
  },
  REPORT_ASSIGNED: {
    en: 'A worker has been assigned to your report.',
    bn: 'আপনার রিপোর্টের জন্য একজন কর্মীকে দায়িত্ব দেওয়া হয়েছে।',
  },
  WORK_STARTED: {
    en: 'Work on your report has started.',
    bn: 'আপনার রিপোর্টের কাজ শুরু হয়েছে।',
  },
  REPORT_RESOLVED: {
    en: 'Your report was resolved. Let the organization know whether it is fixed.',
    bn: 'আপনার রিপোর্টের সমাধান হয়েছে। সমস্যাটি ঠিক হয়েছে কি না প্রতিষ্ঠানকে জানান।',
  },
  REPORT_REOPENED: {
    en: 'Your report was reopened.',
    bn: 'আপনার রিপোর্ট পুনরায় খোলা হয়েছে।',
  },
  REPORT_CLOSED: {
    en: 'Your report was closed.',
    bn: 'আপনার রিপোর্ট বন্ধ করা হয়েছে।',
  },
  PUBLIC_UPDATE_POSTED: {
    en: 'The organization posted an update on your report.',
    bn: 'প্রতিষ্ঠান আপনার রিপোর্টে একটি হালনাগাদ দিয়েছে।',
  },
  NEW_REPORT: {
    en: 'A new report is waiting for review.',
    bn: 'একটি নতুন রিপোর্ট পর্যালোচনার অপেক্ষায় আছে।',
  },
  INFORMATION_PROVIDED: {
    en: 'A citizen answered your question about a report.',
    bn: 'একজন নাগরিক একটি রিপোর্ট নিয়ে আপনার প্রশ্নের উত্তর দিয়েছেন।',
  },
  REPORT_WITHDRAWN: {
    en: 'A citizen withdrew a report.',
    bn: 'একজন নাগরিক একটি রিপোর্ট প্রত্যাহার করেছেন।',
  },
  TASK_DECLINED: {
    en: 'A worker declined a task. The report needs a new worker.',
    bn: 'একজন কর্মী একটি কাজ ফিরিয়ে দিয়েছেন। রিপোর্টটির জন্য নতুন কর্মী প্রয়োজন।',
  },
  TASK_RETURNED: {
    en: 'A worker returned a task. The report needs a new worker.',
    bn: 'একজন কর্মী একটি কাজ ফেরত দিয়েছেন। রিপোর্টটির জন্য নতুন কর্মী প্রয়োজন।',
  },
  WORK_SUBMITTED: {
    en: 'Completed work is waiting for verification.',
    bn: 'সম্পন্ন কাজ যাচাইয়ের অপেক্ষায় আছে।',
  },
  NOT_FIXED_FEEDBACK: {
    en: 'A citizen says a resolved issue is not fixed.',
    bn: 'একজন নাগরিক বলেছেন সমাধান হওয়া একটি সমস্যা ঠিক হয়নি।',
  },
  ACCEPTANCE_OVERDUE: {
    en: 'A task has not been accepted for 48 hours.',
    bn: '৪৮ ঘণ্টায়ও একটি কাজ গ্রহণ করা হয়নি।',
  },
  TASK_ASSIGNED: {
    en: 'You have a new task.',
    bn: 'আপনার জন্য একটি নতুন কাজ আছে।',
  },
  TASK_CANCELLED: {
    en: 'One of your tasks was cancelled or given to another worker.',
    bn: 'আপনার একটি কাজ বাতিল করা হয়েছে বা অন্য কর্মীকে দেওয়া হয়েছে।',
  },
  MORE_EVIDENCE_NEEDED: {
    en: 'Your completed work needs changes or more evidence.',
    bn: 'আপনার সম্পন্ন কাজে পরিবর্তন বা আরও প্রমাণ প্রয়োজন।',
  },
  WORK_APPROVED: {
    en: 'Your completed work was approved.',
    bn: 'আপনার সম্পন্ন কাজ অনুমোদিত হয়েছে।',
  },
  REPORT_DUPLICATE: {
    en: 'Your report describes the same problem as an existing report and was linked to it.',
    bn: 'আপনার রিপোর্টে একটি বিদ্যমান রিপোর্টের একই সমস্যা বলা হয়েছে, তাই এটিকে সেটির সঙ্গে যুক্ত করা হয়েছে।',
  },
};

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
    case 'organization-invitation':
      // The invitee may not have an account yet, so the greeting does not use a name.
      return {
        subject: bn
          ? 'সিভিকআই-এ একটি প্রতিষ্ঠানে যোগদানের আমন্ত্রণ'
          : 'You are invited to join an organization on CivicEye',
        greeting: () => (bn ? 'শুভেচ্ছা,' : 'Hello,'),
        paragraphs: [
          bn
            ? `আপনাকে সিভিকআই-এ "${template.organizationName}"-এ ${template.role} হিসেবে যোগ দিতে আমন্ত্রণ জানানো হয়েছে। আমন্ত্রণটি ৭ দিন কার্যকর থাকবে।`
            : `You have been invited to join "${template.organizationName}" on CivicEye as ${template.role}. The invitation is valid for 7 days.`,
          bn
            ? 'গ্রহণ করতে এই ইমেইল ঠিকানা দিয়ে সাইন ইন করুন (প্রয়োজনে অ্যাকাউন্ট খুলুন ও ইমেইল যাচাই করুন), তারপর নিচের লিংকে ক্লিক করুন।'
            : 'To accept, sign in with this email address (create an account and verify your email if needed), then use the link below.',
        ],
        action: { label: bn ? 'আমন্ত্রণ গ্রহণ করুন' : 'Accept invitation', link: template.link },
        footer: bn ? FOOTER.bn : FOOTER.en,
      };
    case 'notification':
      return {
        subject: bn ? 'সিভিকআই-এ নতুন হালনাগাদ' : 'New activity on CivicEye',
        greeting: (name) => (bn ? `প্রিয় ${name},` : `Hello ${name},`),
        paragraphs: [
          NOTIFICATION_SENTENCES[template.type][bn ? 'bn' : 'en'],
          ...(template.reportPublicId
            ? [bn ? `রিপোর্ট: ${template.reportPublicId}` : `Report: ${template.reportPublicId}`]
            : []),
          bn
            ? 'বিস্তারিত দেখতে সিভিকআই-এ সাইন ইন করুন। ইমেইল সেটিংস আপনার অ্যাকাউন্ট পাতায় বদলানো যায়।'
            : 'Sign in to CivicEye to see the details. You can change email settings on your account page.',
        ],
        action: { label: bn ? 'খুলুন' : 'Open', link: template.link },
        footer: bn ? FOOTER.bn : FOOTER.en,
      };
    case 'organization-contact-confirmation':
      return {
        subject: bn
          ? 'সিভিকআই-এ আপনার প্রতিষ্ঠানের যাচাই নিশ্চিত করুন'
          : 'Confirm your organization’s verification on CivicEye',
        greeting: (name) => (bn ? `প্রিয় ${name},` : `Hello ${name},`),
        paragraphs: [
          bn
            ? `আপনাকে সিভিকআই-এ "${template.organizationName}"-এর যাচাইয়ের জন্য যোগাযোগ ব্যক্তি হিসেবে উল্লেখ করা হয়েছে। এই প্রতিষ্ঠান সিভিকআই ব্যবহার করছে তা নিশ্চিত করতে নিচের লিংকে ক্লিক করুন। লিংকটি ৭ দিন কার্যকর থাকবে।`
            : `You have been named as the verification contact for "${template.organizationName}" on CivicEye. Use the link below to confirm that this organization is using CivicEye. The link is valid for 7 days.`,
          bn
            ? 'এই অনুরোধ সম্পর্কে আপনার জানা না থাকলে লিংকে ক্লিক করবেন না।'
            : 'If you do not recognize this request, do not use the link.',
        ],
        action: { label: bn ? 'নিশ্চিত করুন' : 'Confirm', link: template.link },
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
