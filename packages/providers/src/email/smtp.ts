import { createTransport, type Transporter } from 'nodemailer';
import type { EmailAdapter, EmailMessage, EmailResult } from './types.js';

export interface SmtpEmailOptions {
  host: string;
  port: number;
  /** STARTTLS on 587, implicit TLS on 465. Both are normal; plaintext is not. */
  secure: boolean;
  user: string;
  pass: string;
  /** The From: header, e.g. `YUHA <no-reply@yuha.studio>`. */
  from: string;
  timeoutMs?: number;
}

/**
 * SMTP, because SES, SendGrid and Resend all speak it.
 *
 * Choosing between them is an account decision, and this adapter is what lets
 * that decision be made later — and changed — without touching anything that
 * composes a message.
 *
 * A failure here is reported, never thrown onward: a notice that could not be
 * sent must not take down the sign-in it was describing. The caller gets
 * `delivered: false` and the reason goes to the log.
 */
export class SmtpEmailAdapter implements EmailAdapter {
  readonly kind = 'smtp' as const;
  private readonly transport: Transporter;

  constructor(
    private readonly opts: SmtpEmailOptions,
    private readonly log: (line: Record<string, unknown>) => void,
  ) {
    const timeout = opts.timeoutMs ?? 10_000;
    this.transport = createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.opts.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return { delivered: true, id: info.messageId ?? null };
    } catch (err) {
      // Deliberately not rethrown. The thing this notice describes has already
      // happened; failing the request would turn "we could not warn you" into
      // "you could not sign in".
      this.log({
        event: 'email_send_failed',
        adapter: 'smtp',
        to: message.to,
        subject: message.subject,
        error: (err as Error).message,
      });
      return { delivered: false, id: null };
    }
  }
}
