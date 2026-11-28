/**
 * The production benchmark's input: every render it will make, decided here
 * and nowhere else (docs/MUSIC_PRODUCTION_SPEC.md §1).
 *
 * For each brief and each fixed seed, two requests:
 *   A — the intent as the text-intent step produces it today, sent exactly as
 *       the HTTP adapter sends it (engineSubmitBody);
 *   B — the same intent after compileProductionPlan, which may change only
 *       `brief` and `lyrics`.
 * Each request carries the tag string the DGX service will build from it
 * (engineTagsV2), and the Python runner refuses to render one whose string
 * its own build_tags_v2 does not reproduce. So "what the engine was told" is
 * written down before anything is rendered, and checked again where it runs.
 */
import { createHash } from 'node:crypto';
import { compileProductionPlan, engineTagsV2, musicIntent, productionPlanFor } from '@yuha/contracts';
import { engineSubmitBody } from '@yuha/providers';

/** What the adapter is configured with for the DGX service; `model` is not read by it. */
const ENGINE = { model: 'yuha-dgx', supportsInstrumentalOnly: true, supportsVocals: true };
const FORMAT = 'mp3';
const BODY_KEYS = ['duration_seconds', 'prompt', 'tempo', 'energy', 'instruments', 'style_tags', 'instrumental', 'lyrics', 'format'];

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/** The fields of a body that are allowed to differ between A and B. */
export const DESIGN_FIELDS = ['prompt', 'lyrics'];

function request(intent) {
  const body = engineSubmitBody(intent, FORMAT, ENGINE);
  // Only what the service reads; `model` is the adapter's, not the engine's.
  return Object.fromEntries(BODY_KEYS.filter((k) => k in body).map((k) => [k, body[k]]));
}

/**
 * @param {{ version: number, seeds: number[], briefs: Array<{ id: string, language: string, template: 'pop'|'ballad', description: string, intent: unknown }> }} input
 */
export function buildManifest(input) {
  const entries = [];
  const plans = {};
  for (const brief of input.briefs) {
    const a = musicIntent.parse({ ...brief.intent, lyrics: brief.intent.lyrics ?? null, title: brief.intent.title ?? null });
    const plan = productionPlanFor(brief.template, a);
    const compiled = compileProductionPlan(a, plan);
    if (!compiled.ok) throw new Error(`${brief.id}: the plan does not compile (${compiled.reason})`);
    plans[brief.id] = { plan, report: compiled.report };
    const arms = { A: request(a), B: request(compiled.intent) };
    for (const [key, value] of Object.entries(arms.A)) {
      if (!DESIGN_FIELDS.includes(key) && JSON.stringify(value) !== JSON.stringify(arms.B[key])) {
        throw new Error(`${brief.id}: B changes ${key}, which is not a design variable`);
      }
    }
    for (const seed of input.seeds) {
      for (const [arm, req] of Object.entries(arms)) {
        entries.push({
          id: `${brief.id}-s${seed}-${arm}`,
          brief: brief.id, language: brief.language, template: brief.template, seed, arm,
          request: req,
          expected_tags_v2: engineTagsV2(req),
          input_version: digest(req),
        });
      }
    }
  }
  const manifest = { version: 1, briefs_version: input.version, seeds: input.seeds, entries, plans };
  return { ...manifest, manifest_version: digest({ entries, plans }) };
}
