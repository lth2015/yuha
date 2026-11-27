import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { Loading } from '../components/common';
import { useI18n } from '../lib/i18n';

interface Disclosure {
  configured: boolean;
  isPlaceholder: boolean;
  entityName: string;
  representative: string;
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
// Reviewed by counsel, as confirmed by the operator on 2026-10-19: the terms,
// the privacy policy, the company page and the 特商法 page as they stand in
// this commit (the 支払方法 and 返品・キャンセル rows filled from the
// confirmation screen's reviewed wording in the same change). Text changed
// after this is not covered by that review.
//
// 2026-11-24: the product owner switched on the free trial and photo videos
// before counsel's formal review (expected the next day). The paragraphs that
// disclose them are marked on the page itself as added on that date and under
// legal review (<UnderReview />); they are not covered by the 2026-10-19
// review, and this constant does not claim they are.
const LEGAL_TEXT_REVIEWED = true;

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

/** Marks text added after the last review, on the page, where a reader sees it. */
function UnderReview({ added = '2026-11-24' }: { added?: string }) {
  return <p className="small muted">Added on {added}; this part is under legal review.</p>;
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

function Section({ h, id, children }: { h: string; id?: string; children: ReactNode }) {
  return (
    <section id={id}>
      <h2>{h}</h2>
      {children}
    </section>
  );
}

export function Terms() {
  const d = useDisclosure();
  const { hash } = useLocation();
  // A link to one section (the BGM page links to #bgm) lands on it once the
  // page has drawn; the router does not scroll to a hash by itself.
  useEffect(() => {
    if (d && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [d, hash]);
  if (!d) return <Loading />;
  return (
    <LegalPage title="Terms of Service" updated="2026-11-27">
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
        <p>
          If you make a photo video, you confirm before choosing photos that you have the right to use them
          and the images of the people in them, and, where children appear, the permission of their legal
          guardian where the law requires it. The photos, the frames made from them and the resulting video
          are your content under these terms; you are responsible for them, and the rights of the people
          shown are their own, separate from any copyright in the photos.
        </p>
        <UnderReview />
      </Section>
      {/* BGM's limited commercial use (product owner, 2026-11-27). Mirrored,
          use by use, in BGM_ALLOWED_USES / BGM_PROHIBITED_USES, which every
          BGM's usage record freezes (apps/api/src/services/delivery.ts). */}
      <Section h="4a. Background music (BGM)" id="bgm">
        <p>
          Background music you make at /bgm may also be used commercially, within these limits and subject to
          these Terms and applicable law:
        </p>
        <ul>
          <li>as the soundtrack of your own videos, including monetised posts on YouTube, TikTok, Instagram and similar platforms;</li>
          <li>in advertising for your own products, services or shop;</li>
          <li>as background music played in your own shop or at your own events;</li>
          <li>as the background of your own podcasts and live streams.</li>
        </ul>
        <p>
          You may not resell, sublicense or redistribute the audio itself, alone or as part of a music or
          sound library; register it, or have it registered, for copyright or in a content identification
          system (such as YouTube Content ID) as your own work; distribute it to streaming or download stores
          as your own track; use it to train AI models; or present it as a human performance.
        </p>
        <p>
          This is a non-exclusive licence to use the music, not a transfer of copyright. We do not warrant that
          it is original, that it does not infringe third-party rights, or that it can be registered for
          copyright (section 6). Where a platform or the law requires it, disclose that the music is
          AI-generated. Each BGM carries the usage record frozen when it was made, and that record applies to
          it. Songs with vocals or lyrics remain under section 4. Previews of the official catalogue at
          /marketplace are for listening only; licences for catalogue tracks will be offered separately.
        </p>
        <UnderReview added="2026-11-27" />
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
          {d.entityName} — {d.contact}
        </p>
      </Section>
    </LegalPage>
  );
}

export function Privacy() {
  const d = useDisclosure();
  if (!d) return <Loading />;
  return (
    <LegalPage title="Privacy Policy" updated="2026-11-24">
      <DraftBanner isPlaceholder={d.isPlaceholder} />
      <Section h="1. Who we are">
        <p>
          {d.entityName} operates YUHA and is the controller of the personal data described below.
          Privacy contact: {d.contact}.
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
            improve the Service. Our servers' logs can include the IP address a request came from. When you
            sign in from a device we have not seen on your account, we email you a notice that includes that
            device's IP address and browser.
          </li>
          <li>
            <strong>Visit data:</strong> when you open a page, a random identifier your browser creates and
            keeps (not your account and not your IP address), the page's path, the host name of the site that
            linked to it, and the campaign tag in the link (for example <code>?src=…</code>) if there was one.
            We use it to count visits and to learn which links bring people to YUHA. If you create an account
            within a day of arriving, that campaign tag is recorded on the account.
          </li>
          <li>
            <strong>Trial data:</strong> if you make a song without an account, a random identifier your
            browser keeps and a keyed hash of your IP address, used only to limit free trials per device and
            per network. The record we keep for that limit holds the hash, not the address itself.
          </li>
          <li>
            <strong>Photos:</strong> if you make a photo video, your browser resizes the photos you choose and
            draws them into video frames with the song's lyrics; only those frames are sent to our server. The
            frames can still show people who can be identified. We process them only to assemble your video,
            temporarily: they are not stored persistently, not used for anything else and not sent to any AI
            model. They are deleted as soon as the video is made, or, if processing fails or is interrupted,
            within 24 hours at most. The finished video is sent straight to your device and is not kept by
            us. The original photos do not leave your device.
          </li>
        </ul>
        <UnderReview />
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
        <ul>
          <li>
            A song made without an account is deleted with its audio and everything entered to make it 7 days
            after it was made, unless you add it to an account before then.
          </li>
          <li>
            Trial records (the device identifier and the hash of your IP address) are deleted 7 days after the
            trial, whether or not you then create an account.
          </li>
          <li>
            Individual page views are deleted after 13 months; we keep them that long only to compare how the
            same campaigns perform from one year to the next.
          </li>
          <li>
            When you confirm your age and accept the terms, we keep that you did, when, and which wording you
            were shown, while your account exists.
          </li>
        </ul>
        <UnderReview />
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
          We use your browser's local storage for: your sign-in session; your language; drafts of unsent
          creations; the random visit identifier and, for 30 days, the campaign tag described in section 2;
          the random trial identifier and a trial session, until the trial is added to an account or
          expires; which gift songs you have already opened; and where to return after a payment. We set one
          cookie, only while you sign in with Google, to protect that sign-in from being hijacked; it lasts at
          most 10 minutes. No advertising or tracking cookies are used.
        </p>
        <UnderReview />
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
      <nav className="stack legal-index">
        <Link to="/legal/terms">{t('footer.terms')}</Link>
        <Link to="/legal/privacy">{t('footer.privacy')}</Link>
        <Link to="/legal/company">{t('footer.company')}</Link>
        <Link to="/legal/tokushoho">{t('footer.tokushoho')}</Link>
        <Link to="/help/rights">{t('footer.rights')}</Link>
      </nav>
      {/*
        Who stewards the code is not who operates the service. Nothing on this
        page names the operator — it is a list of links, and the operator is on
        the two pages that carry the disclosure — so the paragraph names the
        page to go to rather than saying "above", and says explicitly that the
        steward is not the operator and not a party to a purchase. A reader who
        sees a community credited on a legal page will otherwise assume it is
        the counterparty. See GOVERNANCE.md.
      */}
      <p className="small muted">{t('legal.steward')}</p>
    </LegalPage>
  );
}

export function Company() {
  const { t } = useI18n();
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
      {/*
        Apache-2.0 conveys the code, not the business. The operator block above
        is the counterparty to every purchase; this section exists so that
        nobody reads the open-source credit in the footer as naming it — which
        is why it is the one section on this English page that reads in the
        visitor's own language.
      */}
      <Section h={t('legal.software')}>
        <p>{t('legal.steward')}</p>
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
