import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  MusicCapabilities,
  MusicPollResult,
  MusicProvider,
  MusicSubmitRequest,
  MusicSubmitResult,
} from './types.js';

export interface DemoProviderOptions {
  /** Directory of our own synthesised fixture audio (scripts/make-audio-fixtures.mjs). */
  fixturesDir: string;
  /** Simulated upstream latency before a submitted request completes. */
  latencyMs?: number;
  /**
   * Deterministic fault injection for the GEN-* tests. Keyed by a marker the
   * test puts in the brief, so production-shaped code paths get exercised
   * without a special test-only branch in the worker.
   */
  faults?: {
    failOnBriefContaining?: string;
    rejectOnBriefContaining?: string;
    unknownOnBriefContaining?: string;
    hangOnBriefContaining?: string;
  };
}

interface PendingRequest {
  requestKey: string;
  providerRequestId: string;
  readyAt: number;
  fixture: string;
  /**
   * Read off the fixture name once, when it is chosen. poll() used to re-parse
   * the name and fall back to 30 if the pattern missed — the same guess that made
   * a stale fixture set undiagnosable, in a second place. Selection is the only
   * step that knows how long the file is, so it is the only step that decides.
   */
  declaredDurationSeconds: number;
  hang: boolean;
}

/**
 * Demo music provider.
 *
 * Serves audio we synthesised ourselves, so nothing here depends on an
 * unsigned upstream agreement. §3.1 requires the demo path to be impossible to
 * confuse with a real one, so `commercialDeliveryPermitted` is false and the
 * provider id is literally "demo-local" — it appears in every licence record.
 *
 * Passing tests against this adapter says the engineering flow works. It says
 * nothing about model quality, originality or commercial viability (§8).
 */
export class DemoMusicProvider implements MusicProvider {
  static readonly PROVIDER_ID = 'demo-local';

  private readonly opts: DemoProviderOptions;
  private readonly inflight = new Map<string, PendingRequest>();
  private fixtures: string[] = [];

  constructor(opts: DemoProviderOptions) {
    this.opts = opts;
  }

  capabilities(): MusicCapabilities {
    return {
      providerId: DemoMusicProvider.PROVIDER_ID,
      model: 'demo-synth-v2',
      contractVersion: 'demo-no-contract',
      supportedDurationsSeconds: [30, 60, 120, 180, 240],
      supportedFormats: ['mp3'],
      supportsInstrumentalOnly: true,
      // The synthesised fixtures stand in for sung output too: demo mode
      // exercises the pipeline, not the model. Every licence record still says
      // demo-local, so the substitution is always visible.
      supportsVocals: true,
      supportsIdempotencyKey: true,
      supportsCancel: true,
      supportsWebhook: false,
      supportsStatusQuery: true,
      // No signed agreement exists, so demo output is never presented as
      // commercially licensed (SEC-09).
      commercialDeliveryPermitted: false,
      maxConcurrency: 8,
      dataRegion: 'local',
      licenseVersion: 'demo-preview-only',
      territory: 'JP',
      allowedUses: ['内部デモ・プレビューのみ'],
      prohibitedUses: ['商用利用', '一般配信', '第三者への再配布', '権利があるかのように提示すること'],
      // Budget assumption from the unit-economics workbook (45 JPY / request),
      // explicitly flagged as an estimate — not a supplier quote.
      costPerRequestMinor: 45,
      billFailedRequests: true,
      costIsEstimate: true,
    };
  }

  private async listFixtures(): Promise<string[]> {
    if (this.fixtures.length) return this.fixtures;
    const entries = await readdir(this.opts.fixturesDir);
    this.fixtures = entries.filter((f) => f.endsWith('.mp3')).sort();
    if (!this.fixtures.length) {
      throw new Error(
        `no demo audio fixtures in ${this.opts.fixturesDir}. Run "pnpm fixtures:audio" first.`,
      );
    }
    return this.fixtures;
  }

  /**
   * Same intent always maps to the same fixture, so re-runs are reproducible.
   * Fixture names carry the length (`night_walk_calm-120s.mp3`) and the pool is
   * restricted to the CLOSEST length ≥ the request, so a 60s request never draws
   * a 4-minute file. Returns null when nothing on disk is long enough.
   *
   * A name the pattern does not match is excluded rather than assumed to be 30s.
   * That assumption is what made a stale fixture set undiagnosable: fixtures
   * generated before the script wrote suffixed names all measured as 30s, so a
   * 120s request drew a 30s file and reported `output_check_failed`. The adapter
   * cannot know an unlabelled file's length, and guessing is worse than saying so.
   */
  private pickFixture(
    req: MusicSubmitRequest,
    fixtures: string[],
  ): { fixture: string; declaredDurationSeconds: number } | null {
    const wanted = req.intent.durationSeconds;
    const withLen = fixtures.flatMap((f) => {
      const m = /-(\d+)s\.mp3$/.exec(f);
      return m ? [{ f, len: Number(m[1]) }] : [];
    });
    const usable = withLen.filter((x) => x.len >= wanted).sort((a, b) => a.len - b.len);
    if (!usable.length) return null;
    const len = usable[0]!.len;
    const pool = usable.filter((x) => x.len === len).map((x) => x.f);
    const seed = createHash('sha256')
      .update(`${req.intent.scene}:${req.intent.mood}:${req.requestKey}`)
      .digest();
    return { fixture: pool[seed.readUInt32BE(0) % pool.length]!, declaredDurationSeconds: len };
  }

  /**
   * Returned when the generated fixtures cannot serve the requested length.
   *
   * `failed` rather than a thrown error: a throw leaves the job mid-flight, its
   * lease expires and another worker retries it forever, whereas this is a
   * terminal state whose code lands in `generation_jobs.error_code` where the
   * next reader will find it. The message carries the remedy because the reader
   * is a developer whose generated fixtures are stale, and the fix is one command.
   */
  private fixtureMissing(wantedSeconds: number, providerRequestId: string): MusicSubmitResult {
    return {
      status: 'failed',
      providerRequestId,
      code: 'demo_fixture_missing',
      message:
        `no demo fixture of at least ${wantedSeconds}s in ${this.opts.fixturesDir}. ` +
        'Run "pnpm fixtures:audio" to generate them.',
    };
  }

  async submit(req: MusicSubmitRequest): Promise<MusicSubmitResult> {
    const faults = this.opts.faults ?? {};
    const brief = req.intent.brief;
    const providerRequestId = `demo_${createHash('sha1').update(req.requestKey).digest('hex').slice(0, 16)}`;

    if (faults.failOnBriefContaining && brief.includes(faults.failOnBriefContaining)) {
      return { status: 'failed', providerRequestId, code: 'demo_injected_failure', message: 'injected failure' };
    }
    if (faults.rejectOnBriefContaining && brief.includes(faults.rejectOnBriefContaining)) {
      return { status: 'rejected', providerRequestId, code: 'demo_injected_rejection', message: 'injected rejection' };
    }
    if (faults.unknownOnBriefContaining && brief.includes(faults.unknownOnBriefContaining)) {
      // Record the request anyway: the point of UNKNOWN is that the upstream
      // may well have accepted it, which is exactly what poll() must discover.
      const fixtures = await this.listFixtures();
      const picked = this.pickFixture(req, fixtures);
      // A fixture set that cannot serve the request at all is the more basic
      // problem, and reporting it beats simulating upstream ambiguity.
      if (!picked) return this.fixtureMissing(req.intent.durationSeconds, providerRequestId);
      this.inflight.set(req.requestKey, {
        requestKey: req.requestKey,
        providerRequestId,
        readyAt: Date.now() + (this.opts.latencyMs ?? 800),
        ...picked,
        hang: false,
      });
      return { status: 'unknown', providerRequestId: null, code: 'demo_injected_unknown', message: 'timeout' };
    }

    const fixtures = await this.listFixtures();
    const hang = !!faults.hangOnBriefContaining && brief.includes(faults.hangOnBriefContaining);
    // Idempotent by request key: a duplicate submit returns the same id and
    // does not start a second upstream job (GEN-01/GEN-04).
    const existing = this.inflight.get(req.requestKey);
    if (existing) return { status: 'submitted', providerRequestId: existing.providerRequestId };

    const picked = this.pickFixture(req, fixtures);
    if (!picked) return this.fixtureMissing(req.intent.durationSeconds, providerRequestId);

    this.inflight.set(req.requestKey, {
      requestKey: req.requestKey,
      providerRequestId,
      readyAt: Date.now() + (this.opts.latencyMs ?? 800),
      ...picked,
      hang,
    });
    return { status: 'submitted', providerRequestId };
  }

  async poll(params: { requestKey: string }): Promise<MusicPollResult> {
    const pending = this.inflight.get(params.requestKey);
    if (!pending) return { status: 'not_found' };
    if (pending.hang || Date.now() < pending.readyAt) return { status: 'pending' };

    const buffer = await readFile(join(this.opts.fixturesDir, pending.fixture));
    return {
      status: 'completed',
      audio: {
        kind: 'buffer',
        buffer,
        format: 'mp3',
        declaredDurationSeconds: pending.declaredDurationSeconds,
        providerRequestId: pending.providerRequestId,
      },
    };
  }

  async cancel(params: { requestKey: string }): Promise<boolean> {
    return this.inflight.delete(params.requestKey);
  }
}
