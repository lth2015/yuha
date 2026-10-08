#!/usr/bin/env node
/**
 * The steward of the code is not the operator of the service.
 *
 * YUHA's code is Apache-2.0 and stewarded upstream by the NEXT community
 * (GOVERNANCE.md). The service at yuha.studio was not donated with it: the
 * Stripe account, the 特定商取引法 販売業者, the privacy controller, refunds
 * and support all stay with its operator, a sole proprietor. Both halves break
 * quietly, in opposite directions:
 *
 *   - Name the steward in a statutory field and the 特商法 disclosure says the
 *     seller is somebody who is not the seller. That is a false statutory
 *     disclosure, not a documentation slip.
 *   - Write the operator into source and an open repository publishes one
 *     person's legal name, home address, mobile number and personal mailbox.
 *     It did: `.env.example`, five documents, a deploy script, a lyric fixture
 *     and the SEC-13 test each carried some of those five values, for no
 *     reason stronger than that they were to hand.
 *
 * The first version of this file checked both by searching whole files for
 * names. An adversarial pass defeated every one of its ✓ lines — a steward
 * written as `Next` rather than `NEXT`, the five rows replaced with hardcoded
 * literals while a comment kept the names it grepped for alive, a `#` comment
 * after `legal:` that emptied the needle list and printed three confident
 * ticks. What survived that pass is the shape below: assert the *value* a
 * reader sees comes from the API, row by row, and let the absence of a literal
 * do the work — then no name, steward's or anyone's, can be in it.
 *
 *   surfaces    — every operator-identity value on every disclosure surface
 *                 is an interpolation of the disclosure the API serves, and
 *                 none of those surfaces names the steward.
 *   refusal     — production refuses to start without the statutory block:
 *                 the condition covers the three fields AND the body actually
 *                 records a problem.
 *   operator    — nothing in this repository knows who the operator is. The
 *                 five fields are supplied only by the runtime secret, and no
 *                 tracked file carries a Japanese address, telephone number or
 *                 off-domain email that is not on a short list of invented
 *                 ones. This replaced a scan for the operator's actual values,
 *                 read out of `deploy/envs/*.yaml`: those files are tracked, so
 *                 while that was the check, the repository itself was the leak.
 *   provenance  — LICENSE is the whole Apache-2.0 text, NOTICE carves out the
 *                 third-party documents in this tree, and package.json says
 *                 Apache-2.0.
 *
 * What it does NOT establish, so that nobody reads more into a green run:
 *
 *   - It reads source, not rendered pages. A value that reaches a page from a
 *     dictionary key or a new component is outside it.
 *   - It checks the working tree, not git history. The operator's details were
 *     committed between 2026-10-02 and 2026-10-08 and are still reachable in
 *     those commits; removing them from HEAD does not remove them from a clone.
 *     `docs/OPEN_ITEMS.md` §8 carries that, and it is what blocks publication.
 *   - A shape is not an identity. It will not notice a name, and a Tokyo
 *     landline it has been told is invented stays invented.
 *   - It cannot read binary files or anything that is not UTF-8/UTF-16. The
 *     run prints how many it skipped rather than implying it read them.
 *
 *   node scripts/check-stewardship.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// ----------------------------------------------------------------- surfaces

/*
 * A surface is a *slice* of a file, and the slice is where the operator's
 * identity is published. Each one declares a marker that must appear inside
 * it, because the way these locators fail is by matching something smaller
 * than intended — `functionBody('Privacy')` returned the 24-character
 * destructuring pattern `{ updated = '2026-09-18' }` the moment the component
 * took a prop, and a 24-character "privacy policy" passed every test below.
 */
function sliceOf(src, open, close) {
  const a = src.indexOf(open);
  if (a < 0) return null;
  const b = src.indexOf(close, a + open.length);
  return b < 0 ? null : src.slice(a, b);
}

/** `<dt>…</dt><dd>…</dd>` pairs, in order, with whitespace collapsed in the label. */
function rows(block) {
  const out = new Map();
  for (const m of block.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    out.set(m[1].replace(/\s+/g, ' ').trim(), m[2]);
  }
  return out;
}

const files = {
  tokushoho: 'apps/web/src/pages/Tokushoho.tsx',
  legal: 'apps/web/src/pages/Legal.tsx',
  checkout: 'apps/web/src/pages/Checkout.tsx',
  publicRoutes: 'apps/api/src/routes/public.ts',
  config: 'apps/api/src/config.ts',
};
const src = {};
for (const [key, path] of Object.entries(files)) {
  if (!existsSync(join(ROOT, path))) {
    problems.push(`${path} is gone; this check no longer covers it`);
    continue;
  }
  src[key] = readText(path);
}

/**
 * Every surface, as: label, text, a marker proving the slice is the real one,
 * and the identity expressions that must appear in it.
 *
 * `rowsMustBe` is the strong form, and the one that does the work: the value a
 * reader sees in that statutory row must be an interpolation of the disclosure
 * the API served. A hardcoded seller, a dictionary key, a steward's name — all
 * of them are *absences* of that expression, so none of them needs its own
 * pattern here.
 */
const surfaces = src.tokushoho === undefined ? [] : [
  {
    label: '特商法 statutory block (Tokushoho.tsx)',
    text: src.tokushoho && sliceOf(src.tokushoho, '<dl className="company-facts tokushoho">', '</dl>'),
    marker: '販売業者',
    rowsMustBe: {
      販売業者: 'd.entityName',
      運営統括責任者: 'd.representative',
      所在地: 'd.address',
      電話番号: 'd.phone',
      メールアドレス: 'd.contact',
    },
  },
  {
    label: '特商法 page, whole file (Tokushoho.tsx)',
    text: src.tokushoho,
    marker: 'useDisclosure()',
  },
  {
    label: 'Company → Operator (Legal.tsx)',
    text: src.legal && sliceOf(src.legal, '<Section h="Operator">', '</Section>'),
    marker: '<dl',
    rowsMustBe: {
      Operator: 'd.entityName',
      Representative: 'd.representative',
      Address: 'd.address',
      Contact: 'd.contact',
      Phone: 'd.phone',
    },
  },
  {
    label: 'Privacy → who we are (Legal.tsx)',
    text: src.legal && sliceOf(src.legal, '<Section h="1. Who we are">', '</Section>'),
    marker: 'controller',
    mustContain: ['d.entityName', 'd.address', 'd.contact'],
  },
  {
    label: 'Terms → the service (Legal.tsx)',
    text: src.legal && sliceOf(src.legal, '<Section h="1. The service">', '</Section>'),
    marker: 'operated by',
    mustContain: ['d.entityName'],
  },
  {
    // The 最終確認画面 carries the seller block too, and is the screen the
    // statute actually cares about — a buyer reaches it holding a card.
    label: 'checkout seller block (Checkout.tsx)',
    text: src.checkout && sliceOf(src.checkout, "<h2 style={{ fontSize: 16, margin: 0 }}>{t('checkout.seller')}", '</section>'),
    marker: 'disclosure.',
    mustContain: ['disclosure.entityName', 'disclosure.address', 'disclosure.contact'],
  },
  {
    label: 'business-disclosure endpoint (public.ts)',
    text: src.publicRoutes && sliceOf(src.publicRoutes, "'/v1/legal/business-disclosure'", '}));'),
    marker: 'ctx.config.LEGAL_ENTITY_NAME',
    mustContain: [
      'entityName: ctx.config.LEGAL_ENTITY_NAME',
      'representative: ctx.config.LEGAL_ENTITY_REPRESENTATIVE',
      'address: ctx.config.LEGAL_ENTITY_ADDRESS',
      'contact: ctx.config.LEGAL_ENTITY_CONTACT',
      'phone: ctx.config.LEGAL_ENTITY_PHONE',
    ],
  },
];

/*
 * Identity tokens, not vocabulary. `/\bsteward/i` and `/\bApache\b/i` were in
 * the first version and had to go: the one edit they fired on was a *correct*
 * disclaimer saying the steward is not the seller, which is the opposite of
 * the thing being prevented. These match the steward's identity in the four
 * scripts and two languages the product is written in, case-insensitively,
 * because `Next` passed a case-sensitive `\bNEXT\b` and `スイス` passed
 * `/瑞士|Swiss/i`.
 *
 * A surface may carry one deliberately, on a line marked
 * `steward-disclosure-ok`, which is a decision somebody wrote down rather than
 * a silent exception.
 */
const STEWARD = [/netx/i, /\bnext\b/i, /ネクスト/, /swiss/i, /スイス/, /瑞士/, /foundation/i, /財団/, /基金会/];
const WAIVER = 'steward-disclosure-ok';

for (const s of surfaces) {
  if (!s.text || s.text.length < 40) {
    problems.push(`${s.label} — could not be located (or is empty); this check no longer covers it`);
    continue;
  }
  if (!s.text.includes(s.marker)) {
    problems.push(`${s.label} — located a slice without "${s.marker}" in it, so it is not the right slice`);
    continue;
  }
  for (const expr of s.mustContain ?? []) {
    if (!s.text.includes(expr)) problems.push(`${s.label} — no longer publishes ${expr}`);
  }
  if (s.rowsMustBe) {
    const found = rows(s.text);
    for (const [label, expr] of Object.entries(s.rowsMustBe)) {
      const cell = found.get(label);
      if (cell === undefined) problems.push(`${s.label} — the ${label} row is gone`);
      else if (!cell.includes(expr)) {
        problems.push(`${s.label} — the ${label} row no longer renders ${expr}: ${cell.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
      }
    }
  }
  for (const line of s.text.split('\n')) {
    if (line.includes(WAIVER)) continue;
    for (const token of STEWARD) {
      const hit = line.match(token);
      if (hit) problems.push(`${s.label} — names the steward: "${hit[0]}" in: ${line.trim().slice(0, 70)}`);
    }
  }
}
notes.push(`${surfaces.length} disclosure surface(s): every operator value comes from the API, none names the steward`);

// ------------------------------------------------------------------ refusal

if (src.config) {
  /*
   * SEC-13. Matched on the condition AND on the body, because the condition is
   * not what refuses: turning `problems.push(…)` into `console.warn(…)` leaves
   * the condition untouched, lets production boot, and sells with a
   * `(not configured)` 特商法 block. The behavioural proof is
   * tests/security.test.ts; this is the cheap structural half that runs
   * without a database.
   */
  const at = src.config.indexOf('if (!e.LEGAL_ENTITY_NAME');
  if (at < 0) {
    problems.push('config.ts — production no longer refuses to start without the statutory block');
  } else {
    const end = src.config.indexOf('\n    }', at);
    const guard = src.config.slice(at, end < 0 ? at + 400 : end);
    const condition = guard.slice(0, guard.indexOf('{'));
    for (const env of ['LEGAL_ENTITY_NAME', 'LEGAL_ENTITY_ADDRESS', 'LEGAL_ENTITY_CONTACT']) {
      if (!condition.includes(env)) problems.push(`config.ts — the production guard dropped ${env}`);
    }
    if (!/problems\.push\(/.test(guard)) {
      problems.push('config.ts — the production guard no longer records a problem, so nothing refuses');
    }
    notes.push('production refuses to start without LEGAL_ENTITY_NAME/ADDRESS/CONTACT');
  }
}

// ----------------------------------------------------------------- operator

/*
 * Nothing here knows the operator.
 *
 * The first version of this section read the operator's real name, address,
 * telephone number and email out of `deploy/envs/*.yaml` and checked that they
 * appeared in no other tracked file. It worked, and it was the wrong shape:
 * those three files are tracked too, so the check's own source of truth was
 * the leak. A ConfigMap made it worse — `kubectl get cm` printed a home
 * address to anyone with read access to the namespace.
 *
 * The five variables now arrive in the runtime Secret from AWS Secrets Manager
 * and are written down nowhere in this repository. That removes the needles,
 * so this checks two different things: that the wiring still routes them that
 * way, and that no tracked file carries anything *shaped* like a Japanese
 * person's contact details unless it is on a list of invented ones.
 */

const LEGAL_VARS = [
  'LEGAL_ENTITY_NAME',
  'LEGAL_ENTITY_REPRESENTATIVE',
  'LEGAL_ENTITY_ADDRESS',
  'LEGAL_ENTITY_CONTACT',
  'LEGAL_ENTITY_PHONE',
];

const CHART_VALUES = ['infra/helm/loopscene/values.yaml', ...tracked.filter((p) => /^deploy\/envs\/.*\.ya?ml$/.test(p))];
const CONFIGMAP = 'infra/helm/loopscene/templates/configmap.yaml';
const EXTERNAL_SECRET = 'deploy/cluster/external-secrets.yaml';

if (!CHART_VALUES.some((p) => /^deploy\/envs\//.test(p))) {
  problems.push('no deploy/envs/*.yaml found; this check no longer covers the deployment wiring');
}
for (const path of CHART_VALUES) {
  if (!existsSync(join(ROOT, path))) continue;
  /*
   * A `legal:` key in a values file is the old arrangement coming back. Matched
   * on the key rather than on a value, because an empty `legal: {}` is how it
   * came back the first time: harmless in itself, and then one environment
   * filled it in.
   */
  if (/^\s*legal:/m.test(readText(path))) {
    problems.push(`${path} — has a \`legal:\` block again; the 特定商取引法 fields come from the runtime secret, not from values in git`);
  }
}
if (existsSync(join(ROOT, CONFIGMAP))) {
  const cm = readText(CONFIGMAP);
  for (const v of LEGAL_VARS) {
    if (new RegExp(`^\\s*${v}:`, 'm').test(cm)) {
      problems.push(`${CONFIGMAP} — defines ${v}; a ConfigMap is unencrypted and \`kubectl get cm\` prints it`);
    }
  }
}
if (!existsSync(join(ROOT, EXTERNAL_SECRET))) {
  problems.push(`${EXTERNAL_SECRET} is gone; the five 特定商取引法 fields have no route to the pods`);
} else {
  const es = readText(EXTERNAL_SECRET);
  for (const v of LEGAL_VARS) {
    if (!new RegExp(`secretKey:\\s*${v}\\b`).test(es)) {
      problems.push(`${EXTERNAL_SECRET} — does not sync ${v}; production would refuse to start, or publish a blank statutory field`);
    }
  }
  notes.push(`the ${LEGAL_VARS.length} 特定商取引法 fields come only from the runtime secret — no values file, no ConfigMap`);
}

/*
 * Invented, and listed so that a real one cannot arrive quietly.
 *
 * Every entry is a test fixture or a documentation example. The rule is that a
 * match of one of the shapes below has to be *exactly* one of these strings —
 * so adding a real address or mobile means adding it here too, in a list
 * called "invented", which is hard to do by accident and obvious in review.
 */
const INVENTED = new Set([
  // tests/security.test.ts — Chiyoda 1-1, both the 〒 form and the bare one
  // the second shape matches through the kanji that follows it.
  '〒100-0001',
  '100-0001',
  // tests/title-screening.test.ts — the numbers a title must not carry, which
  // the screening tests have to spell out in order to test that it refuses.
  '090-1234-5678',
  '08012345678',
  '03-1234-5678',
  '0120-444-444',
  '+81 90 1234 5678',
  // tests/security.test.ts — the invented operator's telephone number.
  '03-0000-0000',
]);

/** Domains that may appear in an email address here. A personal mailbox is the thing being kept out. */
const EMAIL_DOMAINS = [
  'example.com',
  'example.jp',
  'example.test',
  'evil.example',
  'anywhere.test',
  'yuha.studio',
  'netstars.co.jp',
  'mail.netstars.co.jp',
  'netstars.co.jp.evil.test',
  'soundraw.co.jp',
  'apache.org',
  'anthropic.com',
];

const SHAPES = [
  // A postal code: with the 〒, or bare and followed by kanji (`NNN-NNNN 東京都…`).
  [/〒\s*\d{3}-\d{4}/g, 'a Japanese postal code'],
  [/\b\d{3}-\d{4}(?=[\s\u3000]*[\u3005-\u9fff])/g, 'a Japanese postal code'],
  // A mobile, hyphenated, bare, or with the country code.
  [/\b0[789]0-\d{4}-\d{4}\b/g, 'a Japanese mobile number'],
  [/\b0[789]0\d{8}\b/g, 'a Japanese mobile number'],
  [/\+81[\s-]?[789]0[\s-]?\d{4}[\s-]?\d{4}/g, 'a Japanese mobile number'],
  // A landline.
  [/\b0\d{1,3}-\d{2,4}-\d{4}\b/g, 'a Japanese telephone number'],
];

/* Formats this cannot read. Counted and printed, never implied to be clean. */
const UNREADABLE = /\.(png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|pptx?|rtf|mp3|wav|zip|woff2?|ttf|otf|heic|tiff?)$/i;
let skipped = 0;
let scanned = 0;

for (const path of tracked) {
  if (UNREADABLE.test(path)) {
    skipped += 1;
    continue;
  }
  let text;
  try {
    const buf = readFileSync(join(ROOT, path));
    // A UTF-16 file decoded as UTF-8 is mojibake, and mojibake matches nothing.
    const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
    text = buf.toString(utf16 ? 'utf16le' : 'utf8');
    if (!utf16 && text.includes('\u0000')) text += buf.toString('utf16le');
  } catch {
    skipped += 1;
    continue;
  }
  scanned += 1;
  const lineOf = (at) => text.slice(0, at).split('\n').length;
  const reported = new Set();
  for (const [shape, what] of SHAPES) {
    for (const m of text.matchAll(shape)) {
      if (INVENTED.has(m[0].trim())) continue;
      const key = `${what}:${m[0]}`;
      if (reported.has(key)) continue;
      reported.add(key);
      problems.push(
        `${path}:${lineOf(m.index)} — ${what} that is not on the invented list: ${m[0]}. ` +
          'If it is invented, add it to INVENTED in this script; if it is somebody\'s, it does not belong here.',
      );
    }
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const domain = m[1].toLowerCase().replace(/[.,;:)\]]+$/, '');
    if (EMAIL_DOMAINS.includes(domain)) continue;
    const key = `email:${m[0]}`;
    if (reported.has(key)) continue;
    reported.add(key);
    problems.push(
      `${path}:${lineOf(m.index)} — an email address at ${domain}, which is not a domain this repository uses. ` +
        'A personal mailbox does not belong in source; add the domain to EMAIL_DOMAINS only if it is not one.',
    );
  }
}
notes.push(
  `no Japanese address, telephone number or off-domain email in ${scanned} tracked text file(s) ` +
    `(${skipped} in formats this cannot read were not scanned)`,
);

/*
 * The exact values, when whoever runs this has them.
 *
 * A shape cannot catch a name: the operator's is three characters of kanji and
 * looks like any other three. The repository must not hold the values, so this
 * reads them — one per line — from a file git cannot carry:
 * `.git/stewardship-needles`, or `$STEWARDSHIP_NEEDLES_FILE`. Nothing is
 * printed but a count, and a match reports the file and line it found, never
 * the value.
 *
 * Optional on purpose. A contributor who never had the values gets the shape
 * scan above, and the operator gets the real one:
 *
 *   printf '%s\n' '<name>' '<address>' '<phone>' '<email>' > .git/stewardship-needles
 */
const needleFile = process.env.STEWARDSHIP_NEEDLES_FILE ?? join(ROOT, '.git/stewardship-needles');
if (existsSync(needleFile)) {
  const exact = readFileSync(needleFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 2 && !l.startsWith('#'));
  let hits = 0;
  for (const path of tracked) {
    if (UNREADABLE.test(path)) continue;
    let text;
    try {
      text = readText(path);
    } catch {
      continue;
    }
    for (const needle of exact) {
      const at = text.indexOf(needle);
      if (at < 0) continue;
      hits += 1;
      problems.push(
        `${path}:${text.slice(0, at).split('\n').length} — carries one of the values in ${needleFile}. ` +
          'Not printed here; open that line.',
      );
    }
  }
  if (!hits) notes.push(`${exact.length} exact value(s) from ${needleFile} appear in no tracked file`);
} else {
  notes.push(
    'no exact-value list present, so only shapes were checked — see the comment above ' +
      '`.git/stewardship-needles` if you hold the operator\'s five fields',
  );
}

// --------------------------------------------------------------- provenance

for (const f of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'GOVERNANCE.md']) {
  if (!existsSync(join(ROOT, f))) problems.push(`${f} is missing — a donated repository conveys nothing without it`);
  else if (readText(f).trim().length < 200) problems.push(`${f} is a stub`);
}

if (existsSync(join(ROOT, 'LICENSE'))) {
  /*
   * Apache-2.0 §4(a) says a copy of the License must be conveyed. Two header
   * lines are not a copy, and `/Apache License/ && /Version 2.0, January 2004/`
   * accepted a five-line stub, so the nine numbered sections and the closing
   * line are each required.
   */
  const licence = readText('LICENSE');
  const required = [
    'Apache License',
    'Version 2.0, January 2004',
    'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    '1. Definitions.',
    '2. Grant of Copyright License.',
    '3. Grant of Patent License.',
    '4. Redistribution.',
    '5. Submission of Contributions.',
    '6. Trademarks.',
    '7. Disclaimer of Warranty.',
    '8. Limitation of Liability.',
    '9. Accepting Warranty or Additional Liability.',
    'END OF TERMS AND CONDITIONS',
    'APPENDIX: How to apply the Apache License to your work.',
  ];
  const missing = required.filter((r) => !licence.includes(r));
  if (missing.length) problems.push(`LICENSE is not the whole Apache-2.0 text; missing: ${missing.join(', ')}`);
  else notes.push('LICENSE is the whole Apache-2.0 text, all nine sections');
}

const pkg = JSON.parse(readText('package.json'));
if (pkg.license !== 'Apache-2.0') {
  problems.push(`package.json license is ${JSON.stringify(pkg.license)}, not "Apache-2.0"`);
}

/*
 * Third-party documents in this tree. NOTICE says the Apache grant covers
 * "everything except" these, which is only true while it lists all of them —
 * and `spec/` is not the whole list: `PROJECT_TASK.md` at the root is a
 * byte-identical copy of `spec/TokenStars_Music_Codex_Task.md`, so the same
 * brief was carved out and licensed at the same time. Declared here, and each
 * one asserted to be tracked, so that deleting one of these files fails this
 * check instead of leaving a carve-out for nothing.
 */
const THIRD_PARTY = [
  'spec/API Pro Plan - API General Agreement & Licensing terms.md',
  'spec/TokenStars_Music_Codex_Task.md',
  'spec/TokenStars_Music_Product_Design_v0_1.docx',
  'spec/TokenStars_Music_Unit_Economics.xlsx',
  'PROJECT_TASK.md',
];
const CARVE_OUT = 'are NOT licensed under Apache-2.0';

if (existsSync(join(ROOT, 'NOTICE'))) {
  const notice = readText('NOTICE');
  if (!notice.includes(CARVE_OUT)) {
    // `notice.includes(path)` tests mention, not exclusion: the lead-in was
    // rewritten to "including the following files, relicensed under the
    // donation agreement" with the paths untouched, and the check stayed green.
    problems.push(`NOTICE no longer says the listed files "${CARVE_OUT}"`);
  }
  const carved = notice.slice(notice.indexOf(CARVE_OUT));
  for (const f of THIRD_PARTY) {
    if (!tracked.includes(f)) problems.push(`${f} is listed as third-party here but is not tracked; fix this list`);
    else if (!carved.includes(f)) problems.push(`NOTICE does not carve out ${f}; Apache-2.0 would be claimed over it`);
  }
  // Anything new under spec/ is third-party by location and has to be declared.
  for (const f of tracked.filter((p) => p.startsWith('spec/'))) {
    if (!THIRD_PARTY.includes(f)) problems.push(`${f} is new under spec/; add it to THIRD_PARTY here and to NOTICE`);
  }
  notes.push(`${THIRD_PARTY.length} third-party document(s) carved out of the Apache grant`);
}

// -------------------------------------------------------------------- verdict

if (problems.length) {
  console.log(`${problems.length} stewardship problem(s):\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nGOVERNANCE.md says why these are not matters of taste.');
  process.exit(1);
}
for (const n of notes) console.log(`✓ ${n}`);
