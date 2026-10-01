/**
 * Who may use the development sign-in.
 *
 * The dev adapter signs in any address it is given, with no password: that is
 * what makes it a development affordance. The DGX intranet build runs on it,
 * so anyone who could reach the page could sign in as anyone, including the
 * seeded admin@example.jp. DEV_LOGIN_ALLOWLIST narrows it:
 *
 *   DEV_LOGIN_ALLOWLIST=@netstars.co.jp,partner@example.com
 *
 * An entry starting with "@" admits every address at that domain (exactly
 * that domain, not its subdomains); any other entry is one exact address.
 * Comparison is case-insensitive. Unset or empty means unrestricted, which is
 * the local-development default.
 *
 * This is a fence against strangers and typos, not authentication: a
 * colleague who knows another allowed address can still sign in as it.
 */
export interface DevLoginAllowlist {
  restricted: boolean;
  domains: string[];
  emails: string[];
}

export function parseDevLoginAllowlist(raw: string | undefined | null): DevLoginAllowlist {
  const entries = (raw ?? '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const domains = entries.filter((e) => e.startsWith('@') && e.length > 1).map((e) => e.slice(1));
  const emails = entries.filter((e) => !e.startsWith('@'));
  return { restricted: domains.length + emails.length > 0, domains, emails };
}

export function devLoginAllowed(email: string, list: DevLoginAllowlist): boolean {
  if (!list.restricted) return true;
  const e = email.trim().toLowerCase();
  if (list.emails.includes(e)) return true;
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  return list.domains.includes(e.slice(at + 1));
}
