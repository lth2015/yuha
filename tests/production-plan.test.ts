import { describe, expect, it } from 'vitest';
import {
  compileProductionPlan,
  engineBriefPhrases,
  engineTagsV2,
  productionPlan,
  productionPlanFor,
  type MusicIntent,
} from '@yuha/contracts';
import { engineSubmitBody } from '@yuha/providers';

const LYRICS = [
  '[verse]', 'Last train hums beneath the city', 'Window holds a tired face',
  '', '[chorus]', 'Last train, slow down for me', 'Let the night stay a little longer',
  '', '[verse]', 'Every station knows my name', 'None of them will ask me why',
  '', '[chorus]', 'Last train, slow down for me', 'Let the night stay a little longer',
].join('\n');

const base: MusicIntent = {
  scene: 'night', mood: 'calm', energy: 0.5, tempoHint: 'medium',
  instruments: ['electric_piano', 'bass', 'soft_drums'], durationSeconds: 120,
  vocalMode: 'with_vocals', voice: 'female', styles: ['city pop', 'pop'],
  brief: 'late night city pop, nostalgic and warm',
  lyrics: LYRICS, title: null,
} as unknown as MusicIntent;

const cfg = { model: 'acestep', supportsInstrumentalOnly: true, supportsVocals: true };
const tagsOf = (intent: MusicIntent) => engineTagsV2(engineSubmitBody(intent, 'mp3', cfg) as never);

describe('production plan', () => {
  it('a template plan is a valid plan, with the intro and outro around the lyric sections', () => {
    const plan = productionPlanFor('pop', base);
    expect(productionPlan.parse(plan)).toEqual(plan);
    expect(plan.sections.map((s) => s.role)).toEqual(['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro']);
    expect(plan.sections[0]).toMatchObject({ lines: null });
    expect(plan.sections[1]).toMatchObject({ lines: [0, 1] });
    expect(plan.motif.instrument).toBe('electric piano');
  });

  it('changes only the brief and the lyrics, and every production phrase reaches the engine', () => {
    const compiled = compileProductionPlan(base, productionPlanFor('pop', base));
    if (!compiled.ok) throw new Error(compiled.reason);
    const { intent, report } = compiled;
    // The design variable, and nothing else.
    const { brief: _b, lyrics: _l, ...rest } = intent;
    const { brief: _ab, lyrics: _al, ...restA } = base;
    expect(rest).toEqual(restA);
    // What ACE-Step is actually told.
    const tags = tagsOf(intent);
    for (const phrase of report.productionPhrases) expect(tags).toContain(phrase);
    expect(tags).toContain('female vocals');
    expect(tags).toContain('city pop');
    expect(tags).toContain('electric piano');
    expect(report.engineTags).toBe(tags);
  });

  it('adds only known section tags around the lyrics and keeps every lyric line, in order', () => {
    const compiled = compileProductionPlan(base, productionPlanFor('ballad', base));
    if (!compiled.ok) throw new Error(compiled.reason);
    const sung = (l: string) => l.split('\n').filter((x) => x.trim() && !/^\[.*\]$/.test(x.trim()));
    expect(sung(compiled.intent.lyrics!)).toEqual(sung(LYRICS));
    expect(compiled.intent.lyrics!.startsWith('[intro]\n')).toBe(true);
    expect(compiled.intent.lyrics!.trimEnd().endsWith('[outro]')).toBe(true);
    expect(compiled.report.addedTags).toEqual(['intro', 'outro']);
  });

  it('leaves a creator\'s own lyrics untouched', () => {
    const compiled = compileProductionPlan(base, productionPlanFor('pop', base), { creatorLyrics: true });
    if (!compiled.ok) throw new Error(compiled.reason);
    expect(compiled.intent.lyrics).toBe(LYRICS);
    expect(compiled.report.addedTags).toEqual([]);
  });

  it('never pushes a phrase of the brief past the engine\'s four; with no room left it falls back', () => {
    const before = engineBriefPhrases(`female vocals, ${base.brief}`).slice(0, 4);
    const compiled = compileProductionPlan(base, productionPlanFor('pop', base));
    if (!compiled.ok) throw new Error(compiled.reason);
    const after = engineBriefPhrases(`female vocals, ${compiled.intent.brief}`).slice(0, 4);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(compiled.report.displacedPhrases).toEqual([]);
    // Voice + two phrases leaves one slot: the hook, which comes first.
    expect(compiled.report.productionPhrases).toEqual(['electric piano hook returns in chorus']);

    const roomy = { ...base, voice: 'auto', brief: 'late night city pop' } as MusicIntent;
    const two = compileProductionPlan(roomy, productionPlanFor('pop', roomy));
    expect(two.ok && two.report.productionPhrases.length).toBe(2);

    const crowded = { ...base, brief: 'late night city pop, nostalgic, warm neon glow, rain on glass' } as MusicIntent;
    expect(compileProductionPlan(crowded, productionPlanFor('pop', crowded))).toEqual({ ok: false, reason: 'over_budget' });

    // Fourteen tags in all: six styles and four instruments leave no room at the end.
    const longStyles = { ...roomy, styles: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], instruments: ['electric_piano', 'b', 'c', 'd'] } as MusicIntent;
    expect(compileProductionPlan(longStyles, productionPlanFor('pop', longStyles))).toEqual({ ok: false, reason: 'over_budget' });
  });

  it('falls back, with a reason, when the plan cannot be honoured', () => {
    expect(compileProductionPlan({ ...base, vocalMode: 'instrumental' } as MusicIntent, productionPlanFor('pop', base)))
      .toMatchObject({ ok: false, reason: 'instrumental' });
    expect(compileProductionPlan({ ...base, lyrics: null }, productionPlanFor('pop', base)))
      .toMatchObject({ ok: false, reason: 'no_lyrics' });
    const plan = { ...productionPlanFor('pop', base), motif: { instrument: 'harp', idea: 'a four-note hook' } };
    expect(compileProductionPlan(base, plan)).toMatchObject({ ok: false, reason: 'motif_not_in_arrangement' });
  });
});
