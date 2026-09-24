import { readdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { RuntimeInfo } from '@yuha/contracts';
import type { AppContext } from '../context.js';
import { resolveFromRoot } from '../paths.js';

/**
 * Public, unauthenticated endpoints: the runtime descriptor, the sample audio
 * for the landing page, and the legal disclosure block.
 */
export default async function publicRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  app.get('/health', async () => ({ status: 'ok', mode: ctx.config.mode }));

  app.get('/ready', async (_req, reply) => {
    try {
      const { query } = await import('@yuha/db');
      await query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      return reply.status(503).send({ status: 'not-ready', reason: (err as Error).message });
    }
  });

  /**
   * What this deployment actually is. The web app renders the demo banner and
   * disables unavailable features from this, so the interface can never claim a
   * capability the running configuration does not have (§3.1).
   */
  app.get('/v1/runtime', async () => {
    const features = await ctx.features();
    const info: RuntimeInfo = {
      mode: ctx.config.mode,
      demo: ctx.config.isDemo,
      features: {
        subscriptionsEnabled: features.subscriptionsEnabled,
        freeTrialEnabled: features.freeTrialEnabled,
        freeTrialUnits: features.freeTrialEnabled ? ctx.config.FREE_TRIAL_UNITS : 0,
        wavExportEnabled: features.wavExportEnabled,
        commercialDeliveryEnabled: features.commercialDeliveryEnabled,
        realPaymentsEnabled: features.realPaymentsEnabled,
        qrWalletsEnabled: ctx.config.STRIPE_WALLETS_ENABLED,
      },
      adapters: {
        auth: ctx.config.adapters.auth,
        text: ctx.text.providerId,
        music: ctx.music.capabilities().providerId,
        storage: ctx.storage.kind,
        queue: ctx.queue.kind,
        payments: ctx.payments.kind,
      },
      // Publishable key only. A secret key never reaches the browser (SEC-06).
      stripePublishableKey: ctx.config.STRIPE_PUBLISHABLE_KEY ?? null,
      legalEntityConfigured: ctx.config.legalEntityConfigured,
      authMethods: {
        dev: ctx.config.adapters.auth === 'dev',
        google:
          ctx.config.adapters.auth === 'google' ||
          !!(ctx.config.GOOGLE_CLIENT_ID && ctx.config.GOOGLE_CLIENT_SECRET && ctx.config.GOOGLE_REDIRECT_URI),
        googleConfigured: !!(ctx.config.GOOGLE_CLIENT_ID && ctx.config.GOOGLE_CLIENT_SECRET && ctx.config.GOOGLE_REDIRECT_URI),
        cognito: ctx.config.adapters.auth === 'cognito',
      },
    };
    return info;
  });

  /**
   * Landing-page samples (UI-01). In demo mode these are the synthesised
   * fixtures we own outright; the provenance note travels with them so the page
   * can state where the audio came from.
   */
  app.get('/v1/samples', async () => {
    if (ctx.config.adapters.music !== 'demo') {
      // With a real provider, samples must be pre-cleared assets rather than
      // arbitrary generations, so none are served until they are configured.
      return { items: [], provenance: null };
    }
    const dir = resolveFromRoot(ctx.config.DEMO_FIXTURES_DIR ?? './assets/fixtures/audio');
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.mp3')).sort();
    } catch {
      files = [];
    }
    const labels: Record<string, { scene: string; title: string }> = {
      night_walk_calm: { scene: 'night_walk', title: '夜の散歩 / 静けさ' },
      night_walk_dreamy: { scene: 'night_walk', title: '夜景 / 夢見心地' },
      daily_log_warm: { scene: 'daily_log', title: '日常記録 / あたたかさ' },
      outfit_confident: { scene: 'outfit', title: 'コーデ / 自信' },
      gaming_tense: { scene: 'gaming', title: 'ゲーム / 緊張感' },
    };

    const items = await Promise.all(
      files.map(async (file) => {
        const name = file.replace(/\.mp3$/, '');
        const meta = labels[name] ?? { scene: 'daily_log', title: name };
        const signed = await ctx.storage.signedUrl({
          zone: 'delivery',
          key: `samples/${file}`,
          ttlSeconds: 3600,
        });
        return {
          id: name,
          scene: meta.scene,
          title: meta.title,
          durationSeconds: 30,
          url: signed.url,
          demo: true,
        };
      }),
    );

    return {
      items,
      // UI-01 requires a lawful-source record for the samples.
      provenance:
        'これらのサンプルは scripts/make-audio-fixtures.mjs が ffmpeg の発振器で合成した自社生成音源です。' +
        '第三者の録音・サンプル・AI生成物は含まれていません。デモ用であり、音楽モデルの品質を示すものではありません。',
    };
  });

  /**
   * SEC-13: 特定商取引法 disclosure. In demo mode the placeholders are labelled
   * as such; production refuses to boot without real values, so this endpoint
   * can never quietly serve a placeholder to a paying customer.
   */
  app.get('/v1/legal/business-disclosure', async () => ({
    configured: ctx.config.legalEntityConfigured,
    isPlaceholder: !ctx.config.legalEntityConfigured,
    entityName: ctx.config.LEGAL_ENTITY_NAME ?? 'NetStars Co., Ltd.',
    representative: ctx.config.LEGAL_ENTITY_REPRESENTATIVE ?? 'See https://netstars.co.jp',
    address: ctx.config.LEGAL_ENTITY_ADDRESS ?? 'Tokyo, Japan — https://netstars.co.jp',
    contact: ctx.config.LEGAL_ENTITY_CONTACT ?? 'privacy@netstars.co.jp',
    phone: ctx.config.LEGAL_ENTITY_PHONE ?? '—',
    notice: ctx.config.legalEntityConfigured
      ? null
      : 'Company details shown from configuration defaults. Before real charging, replace with the registered legal-entity block (representative, address, contact) and counsel-reviewed terms.',
  }));
}
