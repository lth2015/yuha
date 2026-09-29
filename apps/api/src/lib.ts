/**
 * Library entry point.
 *
 * The worker runs the same domain services as the API — delivery, failure
 * handling, webhook processing — so both processes share one implementation of
 * the ledger and state-machine rules rather than two that can drift apart.
 * Importing this module starts no server.
 */
export { loadConfig, baseFeatures, ConfigError, type AppConfig, type FeatureFlags } from './config.js';
export { createContext, type AppContext } from './context.js';
export { buildServer } from './server.js';
export { createAuthAdapter, DevAuthAdapter, CognitoAuthAdapter, type AuthAdapter } from './auth/index.js';

export {
  createGeneration,
  cancelGeneration,
  getJobView,
  toJobView,
  estimateFor,
  hashRequest,
  currentBalance,
} from './services/generation.js';

export {
  deliver,
  failJob,
  handleLateResult,
  masterKey,
  exportKey,
  quarantineKey,
  LICENSE_DISCLAIMER_JA,
} from './services/delivery.js';

export { createExport, issueDownloadUrl } from './services/exports.js';

export {
  createCheckout,
  getOrderView,
  getEntitlements,
  cancelSubscription,
  listProducts,
  grantTrialIfEligible,
  toJst,
} from './services/billing.js';

export {
  processWebhookEvent,
  recoverUngrantedOrders,
  reconcilePendingCheckouts,
  reconcileUngrantedSubscriptions,
} from './services/webhooks.js';
