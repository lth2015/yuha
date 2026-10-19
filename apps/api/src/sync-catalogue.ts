/**
 * Writes the price catalogue into `product_catalog` and nothing else.
 *
 * For a deployed environment, where `seed` is the wrong tool: it also creates
 * development accounts outside production mode and, with the demo music
 * adapter, public showcase songs. The migration job writes the schema but no
 * products, so until this has run once `/v1/products` is empty and the pricing
 * page has nothing to sell.
 *
 * Run it inside an API pod, which already has the configuration and the
 * database credentials mounted:
 *
 *   kubectl -n qa-music exec deploy/yuha-api -- node api/dist/sync-catalogue.js
 *
 * Run it again after any `STRIPE_PRICE_ID_*` change. Checkout reads the price
 * id from the database row, not from the environment, so changing the
 * ConfigMap and rolling the pods alone does not change what is charged.
 *
 * It does not migrate: the migration job owns the schema, and a catalogue
 * write against a schema that has not been migrated should fail loudly.
 */
import { closeDb } from '@yuha/db';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { syncCatalogue } from './services/catalogue-sync.js';

const config = loadConfig();
const ctx = createContext(config);

let ok = false;
try {
  ok = await syncCatalogue(ctx, config);
} finally {
  await closeDb();
}
process.exit(ok ? 0 : 1);
