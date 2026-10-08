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
 *   operator    — the values in `deploy/envs/*.yaml` appear in no other
 *                 tracked text file. The needles are read from those files at
 *                 run time: a check that hardcoded them would publish exactly
 *                 what it exists to keep out.
 *   provenance  — LICENSE is the whole Apache-2.0 text, NOTICE carves out the
 *                 third-party documents in this tree, and package.json says
 *                 Apache-2.0.
 *
 * What it does NOT establish, so that nobody reads more into a green run:
 *
 *   - It reads source, not rendered pages. A value that reaches a page from a
 *     dictionary key or a new component is outside it.
 *   - `deploy/envs/*.yaml` are themselves tracked, so the operator's details
 *     ARE in this repository, in those three files. This check keeps them from
 *     spreading; it does not make the repository safe to publish. That is
 *     `docs/OPEN_ITEMS.md` §8, and it is a blocking item.
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

const ENV_FILES = tracked.filter((p) => /^deploy\/envs\/.*\.ya?ml$/.test(p));
if (!ENV_FILES.length) problems.push('no deploy/envs/*.yaml found — nothing to read the operator from');

/** The five keys of a `legal:` mapping. Unknown keys are not identities. */
const LEGAL_KEYS = ['entityName', 'representative', 'address', 'contact', 'phone'];

/**
 * One env file's `legal:` block.
 *
 * Deliberately pickier than it looks. `/^\s*legal:\s*$/` required the key to
 * sit alone on its line, so `legal:   # 販売業者 block` produced an empty
 * needle list and a green run — the whole invariant removable by a trailing
 * comment. Quotes of either kind are stripped (a single-quoted value kept its
 * quotes inside the needle, which then matched nothing), and a block scalar
 * (`>-`, `|`) is followed into its continuation lines instead of being taken
 * literally, which is how `>-` itself became a needle and named three
 * innocent files while the address went unwatched.
 */
function legalBlock(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*legal:\s*(#.*)?$/.test(l));
  if (at < 0) return null;
  const indent = lines[at].match(/^\s*/)[0].length;
  const out = new Map();
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const own = line.match(/^\s*/)[0].length;
    if (own <= indent) break;
    if (/^\s*#/.test(line)) continue;
    const kv = line.match(/^\s*([A-Za-z]\w*):\s*(.*?)\s*$/);
    if (!kv) continue;
    let value = kv[2].replace(/\s+#.*$/, '');
    if (/^[|>][-+]?\d*$/.test(value)) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) continue;
        if (lines[j].match(/^\s*/)[0].length <= own) break;
        parts.push(lines[j].trim());
        i = j;
      }
      value = parts.join(' ');
    }
    value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    out.set(kv[1], value.trim());
  }
  return out;
}

const PLACEHOLDER = /^(|-|—|\(not configured\)|TBD|未設定)$/;
const needles = new Map(); // needle -> which field it came from

for (const file of ENV_FILES) {
  const block = legalBlock(readText(file));
  if (!block) {
    problems.push(`${file} — no \`legal:\` block found, so this check read no operator values from it`);
    continue;
  }
  for (const key of LEGAL_KEYS) {
    if (!block.has(key)) {
      problems.push(`${file} — \`legal.${key}\` is missing, so this check does not know that value to look for it`);
    }
  }
  for (const [key, value] of block) {
    if (!LEGAL_KEYS.includes(key) || PLACEHOLDER.test(value)) continue;
    /*
     * The value, plus the ways the same fact gets typed elsewhere. A leak is
     * rarely a copy: the SEC-13 fixture carried the address with the building
     * line cut off, and a phone number arrives unhyphenated, with +81, or
     * with the 〒 dropped from a postal code as often as not.
     *
     * The value itself is always a needle, however short. A six-character
     * floor was tried here and quietly dropped the one that matters most: a
     * Japanese personal name is three characters, so the operator's name
     * pasted into the README passed a run that printed twelve ✓ needles. The
     * floor applies to the derived spellings only, where a short fragment
     * would match prose. (Spelling that name out here, to show the bug, is
     * how this check first failed on its own source. It was right.)
     */
    const variants = new Set();
    for (const m of value.matchAll(/〒?(\d{3}-\d{4})/g)) {
      variants.add(m[0]);
      variants.add(m[1]);
      variants.add(value.slice(m.index + m[0].length).trim()); // the address without its postal code
    }
    for (const m of value.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
      variants.add(m[0]);
      variants.add(m[0].replace('@', '%40'));
      variants.add(m[0].replace('@', ' (at) '));
    }
    for (const m of value.matchAll(/0\d{1,3}-\d{3,4}-\d{3,4}/g)) {
      variants.add(m[0].replace(/-/g, ''));
      variants.add(`+81 ${m[0].slice(1)}`);
      variants.add(`+81${m[0].slice(1).replace(/-/g, '')}`);
    }
    needles.set(value, `legal.${key}`);
    for (const v of variants) if (v.length >= 6) needles.set(v, `legal.${key}`);
  }
}

if (!needles.size) problems.push('no operator values were parsed out of deploy/envs/*.yaml — this check would pass vacuously');

/* Formats this cannot read. Counted and printed, never implied to be clean. */
const UNREADABLE = /\.(png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|pptx?|rtf|mp3|wav|zip|woff2?|ttf|otf|heic|tiff?)$/i;
let skipped = 0;

for (const path of tracked) {
  if (/^deploy\/envs\//.test(path)) continue;
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
  const seen = new Set();
  for (const [needle, field] of needles) {
    const at = text.indexOf(needle);
    if (at < 0 || seen.has(field)) continue;
    seen.add(field);
    problems.push(`${path}:${text.slice(0, at).split('\n').length} — carries the operator's ${field}; it belongs only in deploy/envs/`);
  }
}
if (needles.size) {
  notes.push(
    `${needles.size} spelling(s) of ${LEGAL_KEYS.length} operator field(s) appear in no other tracked text file ` +
      `(${skipped} file(s) in formats this cannot read were not scanned)`,
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
