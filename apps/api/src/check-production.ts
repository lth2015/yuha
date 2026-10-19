/**
 * Would this deployment start, and sell, in production mode? Asked before
 * anyone changes RUN_MODE, by `deploy/k8s/qa/production-check.yaml` — a
 * fresh pod with the current ConfigMap and secret mount. Not `kubectl exec`
 * into a running pod: a container's environment is fixed when it starts, so
 * after a ConfigMap edit an exec would check the old values.
 *
 * Locally, against your own environment: `pnpm check:production`.
 *
 * Reads the pod's environment and mounted secret files the way the
 * application does, asks `loadConfig` with RUN_MODE=production, and — only if
 * that would succeed — asks Stripe (read-only) whether each configured price
 * id is the Price the catalogue means. Starts nothing, writes nothing, prints
 * no value. Exit 0 means the switch can be made; `deploy/PRODUCTION_CUTOVER.md`
 * is the order to make it in.
 */
import { loadConfig } from './config.js';
import { cataloguePrices } from './catalogue.js';
import { createContext } from './context.js';
import { productionReadiness } from './services/production-readiness.js';
import { blocksSelling, describePriceProblem, verifyStripeCatalogue } from './services/stripe-catalogue.js';

const report = productionReadiness(process.env);

console.log(`Runs now as: RUN_MODE=${report.currentMode}`);
console.log(
  `Stripe: secret key ${report.stripe.secretKey}, publishable key ${report.stripe.publishableKey}, webhook secret ${report.stripe.webhookSecret}`,
);

if (!report.ready) {
  console.error(`\n✗ ${report.problems.length} thing(s) stop production mode:\n`);
  for (const p of report.problems) {
    console.error(`  - ${p.what}`);
    console.error(`      fix in: ${p.where}`);
  }
  process.exit(1);
}

/*
 * The configuration would start. Now the money question: is each configured
 * live price id the Price the catalogue means? A swapped CREATOR/STUDIO id
 * charges one amount while the order records another.
 */
const config = loadConfig({ ...process.env, RUN_MODE: 'production' });
const ctx = createContext(config);
const priceProblems = await verifyStripeCatalogue(ctx, cataloguePrices(config));
const blocking = (priceProblems ?? []).filter(blocksSelling);
for (const p of (priceProblems ?? []).filter((x) => !blocksSelling(x))) console.log(`• ${describePriceProblem(p)}`);
if (priceProblems === null) {
  console.error('✗ the production configuration did not produce a Stripe adapter; nothing was compared');
  process.exit(1);
}
if (blocking.length > 0) {
  console.error('\n✗ the configured live prices do not match the catalogue:\n');
  for (const p of blocking) console.error(`  - ${describePriceProblem(p)}`);
  process.exit(1);
}
console.log('\n✓ production mode would start, and the live Stripe prices match the catalogue.');
console.log('  Next: merge the cutover change (RUN_MODE=production) — deploy/PRODUCTION_CUTOVER.md.');
process.exit(0);
