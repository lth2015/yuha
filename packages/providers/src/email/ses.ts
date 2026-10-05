import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { EmailAdapter, EmailMessage, EmailResult } from './types.js';

export interface SesEmailOptions {
  region: string;
  /** The From: header, e.g. `YUHA <no-reply@yuha.studio>`. A verified identity. */
  from: string;
  /** Optional SES configuration set, for bounce and complaint event capture. */
  configurationSet?: string;
}

/**
 * Amazon SES through its own API, not through its SMTP endpoint.
 *
 * Deliberately: SES SMTP needs a dedicated IAM user whose secret key is run
 * through a derivation to become an SMTP password, and that password then has
 * to be stored, rotated and kept out of logs. The API path needs none of it —
 * the cluster already has IRSA enabled with a role per workload, so the
 * credentials are the pod's role and there is no secret to leak. One fewer
 * piece of secret material is worth more here than provider neutrality, which
 * the `smtp` adapter still provides for anyone who wants it.
 *
 * No credentials are passed in. That is the point, not an omission: the
 * default provider chain resolves IRSA in the cluster and whatever a developer
 * has locally, so this file never sees a key.
 */
export class SesEmailAdapter implements EmailAdapter {
  readonly kind = 'ses' as const;
  private readonly client: SESv2Client;

  constructor(
    private readonly opts: SesEmailOptions,
    private readonly log: (line: Record<string, unknown>) => void,
  ) {
    this.client = new SESv2Client({ region: opts.region });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.opts.from,
          Destination: { ToAddresses: [message.to] },
          ...(this.opts.configurationSet ? { ConfigurationSetName: this.opts.configurationSet } : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              // Plain text only. A security notice gains nothing from HTML,
              // and an HTML one is a template for somebody to imitate.
              Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
            },
          },
        }),
      );
      return { delivered: true, id: out.MessageId ?? null };
    } catch (err) {
      // Reported, never rethrown: the event this notice describes has already
      // happened, and failing here would turn "we could not warn you" into
      // "you could not sign in".
      this.log({
        event: 'email_send_failed',
        adapter: 'ses',
        to: message.to,
        subject: message.subject,
        error: (err as Error).message,
      });
      return { delivered: false, id: null };
    }
  }
}
