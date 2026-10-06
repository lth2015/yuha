import {
  AlignmentProvider,
  AudioProcessor,
  DemoMusicProvider,
  EstimatedAlignmentProvider,
  HttpAlignmentProvider,
  HttpMusicProvider,
  createGlmMusicProvider,
  LocalQueueAdapter,
  LocalStorageAdapter,
  LocalTextProvider,
  LogEmailAdapter,
  S3StorageAdapter,
  SimulatedPaymentsAdapter,
  SesEmailAdapter,
  SmtpEmailAdapter,
  SqsQueueAdapter,
  StripePaymentsAdapter,
  TokenStarsTextProvider,
  type EmailAdapter,
  type MusicProvider,
  type PaymentsAdapter,
  type QueueAdapter,
  type StorageAdapter,
  type TextProvider,
  ChainNode,
  DualChainReader,
  httpTransport,
} from '@yuha/providers';
import { getSetting, initDb } from '@yuha/db';
import { baseFeatures, type AppConfig, type FeatureFlags } from './config.js';
import { resolveFromRoot } from './paths.js';

export interface AppContext {
  config: AppConfig;
  music: MusicProvider;
  alignment: AlignmentProvider;
  text: TextProvider;
  storage: StorageAdapter;
  queue: QueueAdapter;
  payments: PaymentsAdapter;
  /**
   * Two Polygon nodes, or undefined when stablecoin payments are off.
   *
   * An adapter like the others, so a test can hand in fakes instead of
   * reaching the network — which is the only way the cases that matter here
   * (a reorg, a stale receipt, two nodes at odds) can be arranged at all.
   */
  chain: DualChainReader | undefined;
  email: EmailAdapter;
  audio: AudioProcessor;
  /** Reads the operator-editable switches on top of the static config. */
  features(): Promise<FeatureFlags>;
}

function buildMusic(cfg: AppConfig): MusicProvider {
  if (cfg.adapters.music === 'demo') {
    return new DemoMusicProvider({
      fixturesDir: resolveFromRoot(cfg.DEMO_FIXTURES_DIR ?? './assets/fixtures/audio'),
      latencyMs: cfg.DEMO_LATENCY_MS,
      faults: {
        // Markers used by the fault-injection tests. They live in the brief, so
        // the worker takes exactly the same path it would in production.
        failOnBriefContaining: '__FAULT_FAIL__',
        rejectOnBriefContaining: '__FAULT_REJECT__',
        unknownOnBriefContaining: '__FAULT_UNKNOWN__',
        hangOnBriefContaining: '__FAULT_HANG__',
      },
    });
  }
  if (cfg.adapters.music === 'glm') {
    return createGlmMusicProvider({
      apiKey: cfg.MUSIC_API_KEY!,
      ...(cfg.MUSIC_MODEL ? { model: cfg.MUSIC_MODEL } : {}),
      ...(cfg.MUSIC_BASE_URL ? { baseUrl: cfg.MUSIC_BASE_URL } : {}),
      ...(cfg.MUSIC_SUBMIT_PATH ? { submitPath: cfg.MUSIC_SUBMIT_PATH } : {}),
      ...(cfg.MUSIC_POLL_PATH ? { pollPath: cfg.MUSIC_POLL_PATH } : {}),
      ...(cfg.MUSIC_REQUEST_ID_FIELD ? { requestIdField: cfg.MUSIC_REQUEST_ID_FIELD } : {}),
      ...(cfg.MUSIC_STATUS_FIELD ? { statusField: cfg.MUSIC_STATUS_FIELD } : {}),
      ...(cfg.MUSIC_AUDIO_URL_FIELD ? { audioUrlField: cfg.MUSIC_AUDIO_URL_FIELD } : {}),
      ...(cfg.MUSIC_STATUS_MAP ? { statusMap: cfg.MUSIC_STATUS_MAP } : {}),
      ...(cfg.MUSIC_IDEMPOTENCY_HEADER ? { idempotencyHeader: cfg.MUSIC_IDEMPOTENCY_HEADER } : {}),
      ...(cfg.MUSIC_ALLOWED_AUDIO_HOSTS ? { allowedAudioHosts: cfg.MUSIC_ALLOWED_AUDIO_HOSTS } : {}),
      ...(cfg.MUSIC_CONTRACT_VERSION ? { contractVersion: cfg.MUSIC_CONTRACT_VERSION } : {}),
      ...(cfg.MUSIC_LICENSE_VERSION ? { licenseVersion: cfg.MUSIC_LICENSE_VERSION } : {}),
      ...(cfg.MUSIC_TIMEOUT_MS !== 60_000 ? { timeoutMs: cfg.MUSIC_TIMEOUT_MS } : {}),
      ...(cfg.MUSIC_MAX_AUDIO_BYTES !== 25 * 1024 * 1024 ? { maxAudioBytes: cfg.MUSIC_MAX_AUDIO_BYTES } : {}),
      ...(cfg.MUSIC_COST_MINOR_PER_REQUEST !== 45 ? { costPerRequestMinor: cfg.MUSIC_COST_MINOR_PER_REQUEST } : {}),
      ...(cfg.MUSIC_COMMERCIAL_DELIVERY ? { commercialDeliveryPermitted: true } : {}),
    });
  }
  const statusMap = JSON.parse(cfg.MUSIC_STATUS_MAP!) as {
    pending: string[];
    completed: string[];
    failed: string[];
    rejected: string[];
  };
  return new HttpMusicProvider({
    providerId: cfg.MUSIC_PROVIDER_ID!,
    baseUrl: cfg.MUSIC_BASE_URL!,
    apiKey: cfg.MUSIC_API_KEY!,
    model: cfg.MUSIC_MODEL!,
    contractVersion: cfg.MUSIC_CONTRACT_VERSION!,
    licenseVersion: cfg.MUSIC_LICENSE_VERSION!,
    territory: 'JP',
    allowedUses: [],
    prohibitedUses: [],
    submitPath: cfg.MUSIC_SUBMIT_PATH!,
    pollPath: cfg.MUSIC_POLL_PATH!,
    ...(cfg.MUSIC_CANCEL_PATH ? { cancelPath: cfg.MUSIC_CANCEL_PATH } : {}),
    requestIdField: cfg.MUSIC_REQUEST_ID_FIELD!,
    statusField: cfg.MUSIC_STATUS_FIELD!,
    audioUrlField: cfg.MUSIC_AUDIO_URL_FIELD!,
    ...(cfg.MUSIC_AUDIO_URL_REWRITE ? { audioUrlRewrite: cfg.MUSIC_AUDIO_URL_REWRITE } : {}),
    statusMap,
    ...(cfg.MUSIC_IDEMPOTENCY_HEADER ? { idempotencyHeader: cfg.MUSIC_IDEMPOTENCY_HEADER } : {}),
    supportsInstrumentalOnly: cfg.MUSIC_SUPPORTS_INSTRUMENTAL,
    supportsVocals: true,
    supportsCancel: cfg.MUSIC_SUPPORTS_CANCEL,
    supportsWebhook: cfg.MUSIC_SUPPORTS_WEBHOOK,
    supportsStatusQuery: cfg.MUSIC_SUPPORTS_STATUS_QUERY,
    supportedDurationsSeconds: [30, 60, 120, 180, 240],
    supportedFormats: cfg.FEATURE_WAV_EXPORT_ENABLED ? ['mp3', 'wav'] : ['mp3'],
    commercialDeliveryPermitted: cfg.MUSIC_COMMERCIAL_DELIVERY,
    maxConcurrency: cfg.MUSIC_MAX_CONCURRENCY,
    dataRegion: cfg.MUSIC_DATA_REGION,
    costPerRequestMinor: cfg.MUSIC_COST_MINOR_PER_REQUEST,
    billFailedRequests: cfg.MUSIC_BILL_FAILED_REQUESTS,
    costIsEstimate: cfg.MUSIC_COST_IS_ESTIMATE,
    timeoutMs: cfg.MUSIC_TIMEOUT_MS,
    maxAudioBytes: cfg.MUSIC_MAX_AUDIO_BYTES,
    allowedAudioHosts: cfg.MUSIC_ALLOWED_AUDIO_HOSTS!.split(',').map((h) => h.trim()).filter(Boolean),
  });
}

function buildAlignment(cfg: AppConfig): AlignmentProvider {
  if (cfg.alignment === 'http') {
    return new HttpAlignmentProvider({
      providerId: cfg.ALIGNMENT_PROVIDER_ID!,
      baseUrl: cfg.ALIGNMENT_BASE_URL!,
      apiKey: cfg.ALIGNMENT_API_KEY!,
      submitPath: cfg.ALIGNMENT_SUBMIT_PATH!,
      linesField: cfg.ALIGNMENT_LINES_FIELD!,
      lineTextField: cfg.ALIGNMENT_LINE_TEXT_FIELD!,
      lineStartField: cfg.ALIGNMENT_LINE_START_FIELD!,
      lineEndField: cfg.ALIGNMENT_LINE_END_FIELD!,
      ...(cfg.ALIGNMENT_WORDS_FIELD ? { wordsField: cfg.ALIGNMENT_WORDS_FIELD } : {}),
      ...(cfg.ALIGNMENT_WORD_TEXT_FIELD ? { wordTextField: cfg.ALIGNMENT_WORD_TEXT_FIELD } : {}),
      ...(cfg.ALIGNMENT_WORD_START_FIELD ? { wordStartField: cfg.ALIGNMENT_WORD_START_FIELD } : {}),
      ...(cfg.ALIGNMENT_WORD_END_FIELD ? { wordEndField: cfg.ALIGNMENT_WORD_END_FIELD } : {}),
      ...(cfg.ALIGNMENT_SECTION_FIELD ? { sectionField: cfg.ALIGNMENT_SECTION_FIELD } : {}),
      timeoutMs: cfg.ALIGNMENT_TIMEOUT_MS,
      // The aligner needs the rendered audio. A provider that keeps its
      // renders (the self-hosted Spark service) names it by request id.
      audioUrlResolver: ({ providerRequestId }) =>
        cfg.ALIGNMENT_AUDIO_URL_TEMPLATE
          ? cfg.ALIGNMENT_AUDIO_URL_TEMPLATE.replace('{id}', encodeURIComponent(providerRequestId))
          : null,
    });
  }
  return new EstimatedAlignmentProvider();
}

function buildText(cfg: AppConfig): TextProvider {
  if (cfg.adapters.text === 'local') return new LocalTextProvider();
  return new TokenStarsTextProvider({
    baseUrl: cfg.TOKENSTARS_BASE_URL!,
    apiKey: cfg.TOKENSTARS_API_KEY!,
    model: cfg.TOKENSTARS_MODEL_ID!,
    chatPath: cfg.TOKENSTARS_CHAT_PATH!,
    ...(cfg.TOKENSTARS_REQUEST_ID_HEADER ? { requestIdHeader: cfg.TOKENSTARS_REQUEST_ID_HEADER } : {}),
    structuredOutputs: cfg.TOKENSTARS_STRUCTURED_OUTPUTS,
    timeoutMs: cfg.TOKENSTARS_TIMEOUT_MS,
    estimatedCostMinorPerRequest: cfg.TOKENSTARS_COST_MINOR_PER_REQUEST,
    lyricSecondsPerLine: cfg.LYRIC_SECONDS_PER_LINE,
  });
}

function buildStorage(cfg: AppConfig): StorageAdapter {
  if (cfg.adapters.storage === 'local') {
    return new LocalStorageAdapter({
      root: resolveFromRoot(cfg.STORAGE_LOCAL_ROOT),
      downloadBaseUrl: `${cfg.PUBLIC_API_URL}/v1/files`,
      signingSecret: cfg.STORAGE_SIGNING_SECRET!,
    });
  }
  return new S3StorageAdapter({
    region: cfg.S3_REGION!,
    quarantineBucket: cfg.S3_QUARANTINE_BUCKET!,
    deliveryBucket: cfg.S3_DELIVERY_BUCKET!,
    ...(cfg.S3_KMS_KEY_ID ? { kmsKeyId: cfg.S3_KMS_KEY_ID } : {}),
  });
}

function buildQueue(cfg: AppConfig): QueueAdapter {
  if (cfg.adapters.queue === 'local') {
    return new LocalQueueAdapter({ queueName: cfg.QUEUE_NAME });
  }
  return new SqsQueueAdapter({ region: cfg.SQS_REGION!, queueUrl: cfg.SQS_QUEUE_URL! });
}

/**
 * Outbound email.
 *
 * `log` is the default outside production and delivers nothing; production
 * refuses it outright in `loadConfig`, because the sign-in and account-change
 * notices are a fraud measure this business has declared to its payment
 * processor, and a measure that cannot leave the building is not one.
 */
function buildEmail(cfg: AppConfig): EmailAdapter {
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ component: 'email', ...line }));
  if (cfg.adapters.email === 'log') return new LogEmailAdapter(log);
  if (cfg.adapters.email === 'ses') {
    return new SesEmailAdapter(
      {
        region: cfg.SES_REGION!,
        from: cfg.EMAIL_FROM!,
        ...(cfg.SES_CONFIGURATION_SET ? { configurationSet: cfg.SES_CONFIGURATION_SET } : {}),
      },
      log,
    );
  }
  return new SmtpEmailAdapter(
    {
      host: cfg.SMTP_HOST!,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      user: cfg.SMTP_USER!,
      pass: cfg.SMTP_PASS!,
      from: cfg.EMAIL_FROM!,
    },
    log,
  );
}

function buildPayments(cfg: AppConfig): PaymentsAdapter {
  if (cfg.adapters.payments === 'simulated') {
    return new SimulatedPaymentsAdapter({
      signingSecret: cfg.STORAGE_SIGNING_SECRET ?? cfg.DEV_AUTH_SECRET ?? 'loopscene-dev-only',
      checkoutBaseUrl: `${cfg.PUBLIC_WEB_URL}/checkout/simulate`,
    });
  }
  return new StripePaymentsAdapter({
    secretKey: cfg.STRIPE_SECRET_KEY!,
    webhookSecret: cfg.STRIPE_WEBHOOK_SECRET!,
    expectLiveMode: cfg.mode === 'production',
    // Only when the account needs one; otherwise the SDK's own pin stands.
    ...(cfg.STRIPE_API_VERSION ? { apiVersion: cfg.STRIPE_API_VERSION } : {}),
  });
}

/**
 * Builds the application context. Called once at start-up by both the API and
 * the worker, so both processes resolve identical adapters from identical
 * configuration.
 */
function buildChainReader(cfg: AppConfig): DualChainReader | undefined {
  if (!cfg.POLYGON_RPC_PRIMARY_URL || !cfg.POLYGON_RPC_SECONDARY_URL) return undefined;
  return new DualChainReader(
    new ChainNode(httpTransport({ label: 'polygon-primary', url: cfg.POLYGON_RPC_PRIMARY_URL })),
    // The label, never the URL: an alert naming the disagreeing node must not
    // print an API key.
    new ChainNode(httpTransport({ label: 'polygon-secondary', url: cfg.POLYGON_RPC_SECONDARY_URL })),
  );
}

export function createContext(config: AppConfig): AppContext {
  initDb({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
  });

  const statics = baseFeatures(config);

  return {
    config,
    music: buildMusic(config),
    alignment: buildAlignment(config),
    text: buildText(config),
    storage: buildStorage(config),
    queue: buildQueue(config),
    payments: buildPayments(config),
    chain: buildChainReader(config),
    email: buildEmail(config),
    audio: new AudioProcessor(),
    async features(): Promise<FeatureFlags> {
      // Operators may only turn things OFF at runtime. Re-enabling something
      // configuration forbids would let a database row defeat the mode rules.
      const overrides = await getSetting<Partial<Record<keyof FeatureFlags, boolean>>>(
        'feature_overrides',
        {},
      );
      return {
        subscriptionsEnabled: statics.subscriptionsEnabled && overrides.subscriptionsEnabled !== false,
        freeTrialEnabled: statics.freeTrialEnabled && overrides.freeTrialEnabled !== false,
        wavExportEnabled: statics.wavExportEnabled && overrides.wavExportEnabled !== false,
        commercialDeliveryEnabled:
          statics.commercialDeliveryEnabled && overrides.commercialDeliveryEnabled !== false,
        realPaymentsEnabled: statics.realPaymentsEnabled,
        generationEnabled: overrides.generationEnabled !== false,
      };
    },
  };
}
