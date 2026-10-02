import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { Loading } from '../components/common';
import { useI18n } from '../lib/i18n';

interface Disclosure {
  configured: boolean;
  isPlaceholder: boolean;
  entityName: string;
  representative: string;
  address: string;
  contact: string;
  phone: string;
  notice: string | null;
}

/**
 * Legal pages.
 *
 * The operator block — name, representative, address, contact, phone — is
 * served by the API from configuration (LEGAL_ENTITY_*), never written here;
 * while those fields are unset the pages say so plainly. Placeholder legal
 * copy is acceptable for a demo and must be replaced with counsel-reviewed
 * text before real charging.
 *
 * The one thing that *was* written here was a hardcoded website row pointing
 * at a company that does not operate this service. The operator is now a sole
 * proprietor and the site is its own domain, so the row is the domain.
 */
export function useDisclosure() {
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  useEffect(() => {
    apiFetch<Disclosure>('/v1/legal/business-disclosure').then(setDisclosure).catch(() => setDisclosure(null));
  }, []);
  return disclosure;
}

/**
 * Whether the operative legal text below has been through counsel.
 *
 * A constant and not configuration, on purpose: the text lives in this
 * repository, so whether it has been reviewed is a fact about the repository.
 * A deployment flag would let an operator silence the warning without anyone
 * having read a word. Flip it in the same commit that lands the reviewed
 * text, and not before.
 */
const LEGAL_TEXT_REVIEWED = false;

/**
 * The banner used to be gated on `isPlaceholder`, which is a different claim.
 *
 * `isPlaceholder` means the LEGAL_ENTITY_* fields are unset. The banner says
 * "this text has not been reviewed by counsel". Those are facts about two
 * different things, and tying them together meant that filling in the last
 * operator field — the 住所 — would have removed a legal warning from the
 * Terms, the Privacy Policy, /legal/company and the 特商法 page, while the
 * text itself stayed exactly as unreviewed as it was the minute before.
 *
 * It shows while either is true now.
 */
export function DraftBanner({ isPlaceholder }: { isPlaceholder: boolean }) {
  if (LEGAL_TEXT_REVIEWED && !isPlaceholder) return null;
  return (
    <div className="alert alert--warn">
      <div className="alert__title">Draft — pending legal review</div>
      <div className="small">
        This text has not been reviewed by counsel. It must be replaced with the reviewed version before any
        real charging begins.
      </div>
    </div>
  );
}

export function LegalPage({ title, updated = '2026-09-18', children }: { title: string; updated?: string; children: ReactNode }) {
  return (
    <article className="legal-page">
      <h1>{title}</h1>
      <p className="small muted">Last updated: {updated}</p>
      {children}
    </article>
  );
}

function Section({ h, children }: { h: string; children: ReactNode }) {
  return (
    <section>
      <h2>{h}</h2>
      {children}
    </section>
  );
}

export function Terms() {
  const d = useDisclosure();
  if (!d) return <Loading />;
  return (
    <LegalPage title="Terms of Service">
      <DraftBanner isPlaceholder={d.isPlaceholder} />
      <Section h="1. The service">
        <p>
          YUHA (the “Service”) is an AI song studio operated by{' '}
          <strong>{d.entityName}</strong> that generates songs from descriptions and lyrics you provide. By
          creating an account or using the Service you agree to these Terms.
        </p>
      </Section>
      <Section h="2. Accounts">
        <p>
          You must be at least 18 years old to generate or purchase songs. You may sign in with Google or
          email. You are responsible for activity under your account and for keeping your access credentials
          secure.
        </p>
      </Section>
      <Section h="3. Credits, plans and payment">
        <p>
          Generation is metered in credits: one credit generates one song. Plans and packs are shown with
          tax-inclusive prices before purchase. Payment is processed by Stripe; we never see or store your
          card details.
        </p>
        <ul>
          <li>DROP pack credits are valid for 90 days from purchase.</li>
          <li>Subscription credits reset each billing period and are not carried over.</li>
          <li>Subscriptions renew monthly until cancelled. You can cancel online at any time; access and credits continue to the end of the paid period.</li>
          <li>A generation that fails for technical reasons never consumes a credit.</li>
        </ul>
      </Section>
      <Section h="4. Your songs and your content">
        <p>
          You retain the prompts and lyrics you submit. Subject to payment and to the usage terms recorded
          with each song at generation time, you may use the songs you generate for personal and creator
          content, including monetised posts on the platforms the plan states. Each song carries a usage
          record you can inspect; terms in force when a song was generated are not retroactively changed.
        </p>
        <p>
          You may not resell the audio itself as a music or stock product, present it as a human performance,
          or use it to train competing music models.
        </p>
      </Section>
      <Section h="5. Acceptable use">
        <p>
          Do not use the Service to imitate the voice or likeness of a real person, to reproduce existing
          songs or lyrics, to infringe rights, to harass, or to generate unlawful content. We may suspend
          content and accounts that violate these rules; where a rights complaint is filed, the song's
          distribution can be paused while the report is reviewed — a pause is not a finding of infringement.
        </p>
      </Section>
      <Section h="6. AI output disclaimer">
        <p>
          Songs are machine-generated. We do not promise that any output is commercially clear for every
          purpose, and a usage record is not a copyright registration or a non-infringement guarantee. You
          are responsible for how you use what you download.
        </p>
      </Section>
      <Section h="7. Availability, changes and termination">
        <p>
          The Service is provided as-is; maintenance and model changes can alter output quality. We may
          update these Terms with notice; continued use after the effective date means acceptance. You may
          delete your account at any time; statutory transaction records are retained as described in the
          Privacy Policy.
        </p>
      </Section>
      <Section h="8. Contact">
        <p>
          {d.entityName} — {d.contact} — {d.address}
        </p>
      </Section>
    </LegalPage>
  );
}

export function Privacy() {
  const d = useDisclosure();
  if (!d) return <Loading />;
  return (
    <LegalPage title="Privacy Policy">
      <DraftBanner isPlaceholder={d.isPlaceholder} />
      <Section h="1. Who we are">
        <p>
          {d.entityName} ({d.address}) operates YUHA and is the controller of the personal data described
          below. Privacy contact: {d.contact}.
        </p>
      </Section>
      <Section h="2. What we collect">
        <ul>
          <li>
            <strong>Account data:</strong> your email address; if you sign in with Google, your Google profile
            id, display name and avatar.
          </li>
          <li>
            <strong>Creation data:</strong> the descriptions, lyrics and settings you submit, and the songs
            generated from them.
          </li>
          <li>
            <strong>Commercial data:</strong> orders, credit batches and billing status. Card data is
            processed by Stripe and never reaches our servers.
          </li>
          <li>
            <strong>Operational data:</strong> service logs and aggregate usage events used to run and
            improve the Service.
          </li>
        </ul>
      </Section>
      <Section h="3. Why we process it">
        <p>
          To provide the Service you asked for (generation, library, publishing, purchases), to keep it
          secure and available, to meet legal obligations, and — only with your separate consent, which you
          may withdraw at any time — to send product news.
        </p>
      </Section>
      <Section h="4. Who processes it for us">
        <ul>
          <li>
            <strong>Amazon Web Services</strong> — hosting in the Tokyo region (ap-northeast-1): the
            application, the MySQL database, audio storage and queues.
          </li>
          <li>
            <strong>Stripe</strong> — payments, subscriptions and refunds.
          </li>
          <li>
            <strong>Google</strong> — sign-in (only if you choose “Continue with Google”).
          </li>
          <li>
            <strong>Music and text model providers</strong> — to generate your songs. The current music
            model's processing region is disclosed in each song's usage record; it may be outside Japan.
          </li>
        </ul>
        <p>
          Prompts and lyrics are shared with model providers only as generation input. We do not sell
          personal data.
        </p>
      </Section>
      <Section h="5. Publishing and public songs">
        <p>
          Songs are private by default. If you publish a song, its title, styles, audio and creator
          display name become publicly visible: anyone holding the link can open it, and it appears in
          the showcase on our home page. Other visitors can play it. You can unpublish at any time,
          which removes it from the showcase and from the link — except that anyone who has bought a
          licence for it keeps their download.
        </p>
      </Section>
      <Section h="6. Retention">
        <p>
          Account and creation data are kept while your account is active. After deletion your account
          profile is anonymised and your songs are removed, published or not — with three exceptions:
          orders and payment records are retained for the statutory period, a song under a rights
          complaint is retained until the review closes, and a song somebody else has licensed is
          retained so that their purchase keeps working.
        </p>
        <p>
          A song you delete yourself leaves your library immediately; its stored audio is removed
          after 90 days, subject to the same two exceptions. Where audio is held in versioned object
          storage, the underlying copies are expired within a further 30 days.
        </p>
      </Section>
      <Section h="7. Your rights">
        <p>
          You may access, correct, export or delete your data, withdraw marketing consent, and unpublish any
          song. To exercise these rights contact {d.contact}. Cancellation of a subscription, deletion of
          your account and unsubscribing from marketing are three separate actions.
        </p>
      </Section>
      <Section h="8. Children">
        <p>The Service is not directed to children; generation and purchase require being 18 or older.</p>
      </Section>
      <Section h="9. Local storage">
        <p>
          We use your browser's local storage for your sign-in session and to keep drafts of unsent
          creations. No advertising or third-party tracking cookies are used.
        </p>
      </Section>
    </LegalPage>
  );
}

/**
 * Where the statutory pages live, so they do not have to live in the footer.
 *
 * The footer used to carry four of them, ending in 「特定商取引法相关标示」 —
 * a legal label in the middle of a product. They are all still one click from
 * every page, and the 特商法 disclosure keeps its own direct link on the
 * checkout screen, which is the placement that carries the obligation.
 */
export function LegalIndex() {
  const { t } = useI18n();
  return (
    <LegalPage title={t('footer.legal')}>
      <nav className="stack">
        <Link to="/legal/terms">{t('footer.terms')}</Link>
        <Link to="/legal/privacy">{t('footer.privacy')}</Link>
        <Link to="/legal/company">{t('footer.company')}</Link>
        <Link to="/legal/tokushoho">{t('footer.tokushoho')}</Link>
        <Link to="/help/rights">{t('footer.rights')}</Link>
      </nav>
    </LegalPage>
  );
}

export function Company() {
  const d = useDisclosure();
  if (!d) return <Loading />;
  return (
    <LegalPage title="Company / Legal Disclosure">
      <DraftBanner isPlaceholder={d.isPlaceholder} />
      <Section h="Operator">
        <dl className="company-facts">
          <div>
            <dt>Operator</dt>
            <dd>{d.entityName}</dd>
          </div>
          <div>
            <dt>Website</dt>
            <dd>
              <a href="https://yuha.studio" target="_blank" rel="noreferrer">
                https://yuha.studio
              </a>
            </dd>
          </div>
          <div>
            <dt>Representative</dt>
            <dd>{d.representative}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{d.address}</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>{d.contact}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{d.phone}</dd>
          </div>
        </dl>
        {d.notice && <p className="small muted">{d.notice}</p>}
      </Section>
      <Section h="Refunds and cancellations">
        <p>
          Subscriptions can be cancelled online at any time and remain active until the end of the paid
          period. For one-time packs, unused credits within the statutory withdrawal window are refunded via
          the original payment method. Contact {d.contact} with your order id.
        </p>
      </Section>
      <Section h="Reporting content">
        <p>
          Rights holders can report a song without an account or any payment from the{' '}
          <a href="/help/rights">report page</a>. Every report receives a case number; reviewed songs are
          suspended from distribution while investigated and restored if dismissed.
        </p>
      </Section>
    </LegalPage>
  );
}

/*
 * `Tokushoho` used to live here as `return <Company />`. It is now its own
 * page: 特定商取引法に基づく表記 requires fields this one does not carry
 * (price, payment method, payment and delivery timing), and a statutory
 * document is not the same object as an about-us page.
 */
