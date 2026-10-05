/**
 * Outbound email.
 *
 * The product had no way to send any, which is why it could not tell anyone
 * their account had been signed into or changed — one of the fraud measures a
 * payment processor asks about, and the one that was easiest to claim and
 * hardest to notice missing.
 *
 * An adapter rather than a provider, for the same reason every other external
 * dependency here is one: choosing SES over SendGrid over Resend is a decision
 * about an account, not about this code. All three speak SMTP, so `smtp`
 * covers them, and `log` covers having no account yet without pretending.
 *
 * Plain text only. A security notice gains nothing from HTML, and an HTML
 * notice is a template for somebody else to imitate convincingly.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailResult {
  /**
   * Whether this actually left the building.
   *
   * `log` returns false, always. A caller that treats "sent" as "the person
   * knows" would be making the mistake this whole seam exists to stop, so the
   * answer is a fact rather than a reassurance.
   */
  delivered: boolean;
  /** Provider message id, when there was a provider. */
  id: string | null;
}

export interface EmailAdapter {
  readonly kind: 'log' | 'smtp' | 'ses';
  send(message: EmailMessage): Promise<EmailResult>;
}
