import type { EmailAdapter, EmailMessage, EmailResult } from './types.js';

/**
 * Writes the notice to the log and delivers nothing.
 *
 * This is the default, and it is what the demo and the office build run with:
 * a product that is being tested by eight colleagues should not be able to put
 * mail in their inboxes by accident, and a deploy should not require an email
 * account before it can start.
 *
 * `delivered: false` is the honest answer and the whole point of the type. The
 * subject and recipient are logged; the body is not, because a sign-in notice
 * names a place and a time and the log is read by more people than the inbox.
 */
export class LogEmailAdapter implements EmailAdapter {
  readonly kind = 'log' as const;

  constructor(private readonly log: (line: Record<string, unknown>) => void) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    this.log({
      event: 'email_not_sent',
      adapter: 'log',
      to: message.to,
      subject: message.subject,
      note: 'EMAIL_ADAPTER=log — nothing was delivered',
    });
    return { delivered: false, id: null };
  }
}
