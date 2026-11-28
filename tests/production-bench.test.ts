import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../scripts/lib/production-bench.mjs';

const briefs = JSON.parse(readFileSync('scripts/production-bench/briefs.json', 'utf8'));
const committed = readFileSync('deploy/dgx/music/server/fixtures/production_bench.json', 'utf8');

describe('production bench manifest', () => {
  it('the committed manifest is what the current compiler makes of the briefs', () => {
    // The DGX renders the committed file; a compiler change that is not
    // regenerated would be benchmarked on yesterday's requests.
    expect(`${JSON.stringify(buildManifest(briefs), null, 2)}\n`).toBe(committed);
  });

  it('twelve A/B pairs over six briefs, every B carrying at least one production phrase', () => {
    const m = buildManifest(briefs);
    expect(m.entries).toHaveLength(24);
    for (const [id, { report }] of Object.entries(m.plans) as Array<[string, { report: { productionPhrases: string[]; displacedPhrases: string[] } }]>) {
      expect(report.productionPhrases.length, id).toBeGreaterThan(0);
      expect(report.displacedPhrases, id).toEqual([]);
    }
  });

  it('refuses a brief whose plan cannot compile rather than benchmarking a B that is A', () => {
    const one = structuredClone(briefs);
    one.briefs = [one.briefs[0]];
    one.briefs[0].intent.instruments = ['bass'];
    one.briefs[0].intent.brief = 'late night city pop, warm, rain on glass, neon, slow walk';
    expect(() => buildManifest(one)).toThrow(/does not compile \(over_budget\)/);
  });
});
