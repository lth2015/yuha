import { readdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { RuntimeInfo } from '@yuha/contracts';
import type { AppContext } from '../context.js';
import { resolveFromRoot } from '../paths.js';
import { freeTrialAvailable } from '../services/billing.js';
import { enabledStablecoinTokens } from '../services/stablecoin-tokens.js';
import { toDisplayAddress } from '@yuha/providers';

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
    const trialAvailable = await freeTrialAvailable(ctx);
    const info: RuntimeInfo = {
      mode: ctx.config.mode,
      demo: ctx.config.isDemo,
      syntheticAudio: ctx.config.adapters.music === 'demo',
      features: {
        subscriptionsEnabled: features.subscriptionsEnabled,
        // Not `features.freeTrialEnabled`: that flag is only half the
        // condition the grant applies. See `freeTrialAvailable`.
        freeTrialEnabled: trialAvailable,
        freeTrialUnits: trialAvailable ? ctx.config.FREE_TRIAL_UNITS : 0,
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
      stablecoin: {
        enabled: ctx.config.STABLECOIN_ENABLED,
        chainId: ctx.config.STABLECOIN_CHAIN_ID,
        /*
         * From the whitelist, filtered by the switches — never a literal
         * written again here. The scanner's filter and the verifier's lookup
         * drifting apart would mean watching one contract and accepting
         * another; the same applies to what the browser is told to pay.
         */
        tokens: enabledStablecoinTokens(ctx.config).map((t) => ({
          key: t.key,
          address: toDisplayAddress(t.address),
          decimals: t.decimals,
          label: t.label,
        })),
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
   * Synthesised sample audio with its provenance note (UI-01 heritage).
   *
   * Not the landing page's source any more, whatever this used to say: Home
   * renders the showcase from `GET /v1/explore`, and nothing in `apps/web`
   * calls this. Kept because it is the one endpoint that serves audio we own
   * outright, which is what a sales or legal conversation needs — but it has
   * no reader in the product, and a route with no reader is a route nobody
   * notices breaking.
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
    /*
     * The unconfigured fallback is a visible placeholder, not a real party.
     *
     * It used to be a live company's name, address and privacy mailbox, so
     * every demo and every local checkout published that company as the
     * operator of this service and as the controller of its users' personal
     * data — `Legal.tsx` renders "{entityName} ({address}) operates YUHA and
     * is the controller of the personal data described below", and the
     * 特商法 page puts the same block under 販売業者. A default should never
     * be able to name somebody; production refuses to start without the real
     * values (SEC-13), and until they are set this says so in the field
     * itself rather than relying on the banner above it.
     */
    entityName: ctx.config.LEGAL_ENTITY_NAME ?? 'YUHA (operator not configured)',
    representative: ctx.config.LEGAL_ENTITY_REPRESENTATIVE ?? '(not configured)',
    address: ctx.config.LEGAL_ENTITY_ADDRESS ?? '(not configured)',
    contact: ctx.config.LEGAL_ENTITY_CONTACT ?? '(not configured)',
    phone: ctx.config.LEGAL_ENTITY_PHONE ?? '—',
    notice: ctx.config.legalEntityConfigured
      ? null
      : 'Company details shown from configuration defaults. Before real charging, replace with the registered legal-entity block (representative, address, contact) and counsel-reviewed terms.',
  }));
}
