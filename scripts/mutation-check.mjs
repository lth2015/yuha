#!/usr/bin/env node
/**
 * Mutation check: reintroduce each fix's defect and demand that a test fails.
 *
 * A fix nobody can break is a fix nobody is testing. Every entry below is a
 * defect this round removed, written back in, with the test file that is
 * supposed to notice. SURVIVED means the test cannot tell.
 *
 * Two traps this harness exists to avoid, both of which have produced false
 * results in this repository:
 *
 *   - A mutation tsc rejects leaves a STALE dist, and the suite then runs
 *     against unmutated code and reports a survival. Every build's exit code
 *     is checked and reported as BUILD FAILED, which is not a survival.
 *   - `git checkout` does not restore an untracked file, and restoring by hand
 *     is how two earlier runs were invalidated. Each target file is copied
 *     verbatim before the run and copied back after. The closing line REPORTS
 *     whether the tree came back clean; it is not a requirement and nothing
 *     exits on it, because the tree is legitimately dirty whenever this runs
 *     against uncommitted work — which is most of the time. (It used to claim
 *     "the tree is required to be clean between mutations". `cleanTree()` is
 *     called once, at the end, and its result is printed.)
 *
 * A third, found while writing round 5: `if (…) {` → `if (false) {` is the
 * obvious way to write a guard out, and inside statically unreachable code
 * TypeScript gives DECLARED rather than narrowed types — so a `user` or
 * `remote` that an earlier guard proved non-null becomes possibly undefined
 * and the build fails. That shows up here as a survival, which is the first
 * trap above wearing a different hat. Where the block below depends on
 * narrowing, use a comparison the compiler cannot fold: `x !== x`.
 *
 * A fourth, and this one cost real time: a run KILLED PARTWAY leaves its
 * defect in the working tree. Each mutation is restored after its own suite,
 * so a Ctrl-C or a timeout between the write and the restore leaves exactly
 * one file defective, with no "tree clean after restore" line printed because
 * the script never reached the end. Two such defects — a stablecoin scan
 * start block and an agreed-receipt log ordering — sat in the tree after two
 * interrupted full runs and were found only because a separate check noticed
 * their mutation anchors no longer matched. So: a marker file records what is
 * currently mutated, and the next run restores it before doing anything else.
 * Run `node scripts/mutation-check.mjs --repair` to do only that.
 *
 * Usage: node scripts/mutation-check.mjs [name-substring | --repair | --anchors]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PRISTINE = '/tmp/mutation-pristine';
const DB = process.env.TEST_DATABASE_URL ?? 'mysql://loopscene:loopscene_local_test@localhost:53307/loopscene_test_a';

const S = 'apps/api/src/services';
const P = 'packages/providers/src/chain';

/**
 * `from`/`to` is one edit; `edits` is several, applied in order, for a defect
 * that takes more than one line to write back — a bypass that needs an import
 * as well as a call, say. All of them must match, or the mutation reports
 * ANCHOR NOT FOUND rather than applying half of itself.
 *
 * @type {Array<{name:string,file:string,from?:string,to?:string,edits?:Array<{from:string,to:string}>,tests:string[]}>}
 */
const MUTATIONS = [
  {
    name: 'orphan-write-takes-the-anti-replay-key',
    file: `${S}/stablecoin-settle.ts`,
    // Anchored with the line above it: `await recordOrphanTransfer(` appears
    // at both orphan call sites, so the bare string applied to whichever came
    // first — a mutation that passes while testing a line it is not about.
    // The `--anchors` uniqueness check is what surfaced that.
    from: `    for (const p of payments) {
      await recordOrphanTransfer(`,
    to: `    for (const p of payments) {
      await recordTransferEvent(
        {
          chainId: obs.transaction.chainId,
          txHash: obs.transaction.hash,
          logIndex: p.logIndex,
          tokenAddress: p.token,
          fromAddress: p.from,
          toAddress: p.to,
          amountAtomic: p.value.toString(),
          blockNumber: obs.block.number,
          blockHash: obs.block.hash,
          blockTime: new Date(obs.block.timestampMs),
          intentId: null,
        },
        tx,
      );
      await recordOrphanTransfer(`,
    tests: ['tests/stablecoin-settle.test.ts'],
  },
  {
    name: 'attribution-from-the-transaction-sender',
    file: `${S}/stablecoin-settle.ts`,
    from: "const intent = await findOpenIntentForPayer({ chainId, payer: payment.from });",
    to: "const intent = await findOpenIntentForPayer({ chainId, payer: observation.transaction.from });",
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'confirm-the-intent-before-asking-if-the-order-moved',
    file: `${S}/stablecoin-settle.ts`,
    from: `    if (!changed) {
      await closeIntent({ intentId: intent.id, state: 'review' }, tx);
      return { kind: 'unpayable' as const, orderId: intent.order_id };
    }
    await closeIntent({ intentId: intent.id, state: 'confirmed' }, tx);`,
    to: `    await closeIntent({ intentId: intent.id, state: 'confirmed' }, tx);
    if (!changed) {
      return { kind: 'unpayable' as const, orderId: intent.order_id };
    }`,
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'no-early-check-for-money-already-settled',
    file: `${S}/stablecoin-settle.ts`,
    from: "  if (already) return { kind: 'already_settled', orderId: already.order_id };",
    to: '  void already;',
    tests: ['tests/stablecoin-settle.test.ts'],
  },
  {
    name: 'pick-the-first-of-several-payments-in-one-transaction',
    file: `${S}/stablecoin-settle.ts`,
    from: `    await orphan(observation, payments, 'several_payments_in_one_transaction', null);
    return { kind: 'unattributed', reason: 'more than one transfer to this service in one transaction' };`,
    to: '    // mutation: carry on with the first one',
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'start-block-defaults-to-zero',
    file: `${S}/stablecoin.ts`,
    from: '  const scanFrom = cursor ?? (configured === undefined ? undefined : BigInt(configured));',
    to: '  const scanFrom = cursor ?? (configured === undefined ? 0n : BigInt(configured));',
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'quoting-does-not-ask-the-chain-about-decimals',
    file: `${S}/stablecoin.ts`,
    from: '  await assertConfiguredTokensVerified(ctx, ctx.chain);',
    to: '  void assertConfiguredTokensVerified;',
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'prepare-refuses-only-a-paid-order',
    file: `${S}/stablecoin.ts`,
    from: `  if (['paid', 'refunded', 'partially_refunded'].includes(order.status)) {
    throw new AppError('CONFLICT', 'this order can no longer be paid');
  }`,
    to: `  if (order.status === 'paid') throw new AppError('CONFLICT', 'this order has already been paid');`,
    tests: ['tests/stablecoin-quote-intent.test.ts'],
  },
  {
    name: 'a-re-quote-leaves-the-orders-other-slot-open',
    file: `${S}/stablecoin.ts`,
    from: `    const openForOrder = await findOpenIntentForOrder(order.id, tx);
    if (openForOrder && openForOrder.id !== openForPayer?.id) {
      await closeIntent({ intentId: openForOrder.id, state: 'cancelled' }, tx);
    }`,
    to: '    void findOpenIntentForOrder;',
    tests: ['tests/stablecoin-quote-intent.test.ts'],
  },
  {
    name: 'the-chain-id-of-the-endpoints-is-never-checked',
    file: `${S}/stablecoin-scan.ts`,
    from: `  for (const problem of await verifyChainIds(reader, ctx.config.STABLECOIN_CHAIN_ID)) {
    problems.push({ token: 'chain', kind: 'unavailable', reason: problem });
  }`,
    to: '  void verifyChainIds;',
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'discovery-asks-one-node',
    file: `${S}/stablecoin-scan.ts`,
    from: '    fetchLogs: (p) => reader.unionLogs(p),',
    to: '    fetchLogs: (p) => reader.primary.logs(p),',
    tests: ['tests/stablecoin-scan.test.ts'],
  },
  {
    name: 'the-transaction-body-comes-from-the-primary',
    file: `${S}/stablecoin-scan.ts`,
    from: `  const agreedTx = await reader.agreedTransaction(transfer.txHash);
  if (!agreedTx.agreed) return { ok: false, reason: agreedTx.reason };
  const tx = agreedTx.value;`,
    to: `  const tx = await reader.primary.transaction(transfer.txHash);
  if (!tx) return { ok: false, reason: 'the primary no longer has that transaction' };`,
    tests: ['tests/stablecoin-scan.test.ts'],
  },
  {
    name: 'one-unverifiable-transfer-stops-the-whole-pass',
    file: `${S}/stablecoin-scan.ts`,
    from: '      continue;\n    }\n    settled.push(await settleStablecoinObservation(ctx, observation.value));',
    to: '      break;\n    }\n    settled.push(await settleStablecoinObservation(ctx, observation.value));',
    tests: ['tests/stablecoin-scan.test.ts'],
  },
  {
    name: 'the-console-discards-whether-the-order-moved',
    file: `${S}/stablecoin-admin.ts`,
    from: `    if (!changed) {
      throw new AppError('CONFLICT', 'that order can no longer be marked paid — it is not in a payable state');
    }
    return item.order_id;`,
    to: '    void changed;\n    return item.order_id;',
    tests: ['tests/stablecoin-admin.test.ts'],
  },
  {
    name: 'a-review-decision-searches-a-page-of-the-queue',
    file: `${S}/stablecoin-admin.ts`,
    from: '    const item = await getStablecoinReviewItem(params.intentId, tx);',
    to: '    const item = (await listStablecoinReviews(100)).find((q) => q.intent_id === params.intentId);',
    tests: ['tests/stablecoin-admin.test.ts'],
  },
  {
    name: 'rejecting-a-payment-records-no-refund-owed',
    file: `${S}/stablecoin-admin.ts`,
    from: '      await markRefundOwed(params.intentId, tx);',
    to: '      void markRefundOwed;',
    tests: ['tests/stablecoin-admin.test.ts'],
  },
  {
    name: 'delivery-trusts-the-order-row-it-was-handed',
    file: `${S}/fulfilment.ts`,
    from: "    if (!order || order.status !== 'paid' || order.entitlement_granted_at) return 'nothing_to_do';",
    to: '    if (!order) return \'nothing_to_do\';',
    tests: ['tests/stablecoin-settle.test.ts'],
  },
  {
    name: 'a-duplicate-licence-is-marked-delivered-anyway',
    file: `${S}/fulfilment.ts`,
    from: `    if (!created) {
      // Not an error and not a delivery. Reported up, where the caller records
      // that a refund is owed and leaves the order visibly undelivered.
      return { delivered: false, reason: 'already_licensed' };
    }`,
    to: '    void created;',
    tests: ['tests/market.test.ts'],
  },
  {
    name: 'grantLicense-reads-created-from-affectedRows',
    file: 'packages/db/src/market.ts',
    from: `  const row = await queryOne<{ order_id: string }>(
    \`SELECT order_id FROM track_licenses WHERE track_id = ? AND buyer_id = ?\`,
    [params.trackId, params.buyerId],
    tx,
  );
  if (!row) throw new Error('license insert failed to read back');`,
    to: `  const row = { order_id: params.orderId };`,
    tests: ['tests/market.test.ts'],
  },
  {
    name: 'expiry-has-no-grace-period',
    file: 'packages/db/src/stablecoin.ts',
    from: '        AND q.expires_at <= UTC_TIMESTAMP(3) - INTERVAL ? SECOND',
    to: '        AND q.expires_at <= UTC_TIMESTAMP(3) - INTERVAL 0 * ? SECOND',
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'agreedHeader-does-not-check-the-height',
    file: `${P}/rpc.ts`,
    from: '    if (a.number !== height || b.number !== height) {',
    to: '    if (a.number !== a.number || b.number !== b.number) {',
    tests: ['tests/stablecoin-rpc.test.ts'],
  },
  {
    name: 'agreedReceipt-ignores-each-logs-own-identity',
    file: `${P}/rpc.ts`,
    from: `          i: l.logIndex,
          h: l.transactionHash,
          n: l.blockNumber.toString(),
          b: l.blockHash,`,
    to: '          i: l.logIndex,',
    tests: ['tests/stablecoin-rpc.test.ts'],
  },
  {
    name: 'agreedReceipt-returns-the-primarys-log-order',
    file: `${P}/rpc.ts`,
    from: '    return { agreed: true, value: { ...a, logs: byLogIndex(a.logs) } };\n  }\n\n  /**\n   * The transaction body',
    to: '    return { agreed: true, value: a };\n  }\n\n  /**\n   * The transaction body',
    tests: ['tests/stablecoin-rpc.test.ts'],
  },
  {
    name: 'decimals-accepts-any-length-of-hex',
    file: `${P}/tokens.ts`,
    from: "    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {",
    to: "    if (!/^0x[0-9a-fA-F]+$/.test(raw)) {",
    tests: ['tests/stablecoin-review-fixes.test.ts'],
  },
  {
    name: 'the-payment-page-formats-an-amount-through-a-number',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: '  const padded = amountAtomic.padStart(decimals + 1, \'0\');',
    to: '  const padded = (Number(amountAtomic) / 10 ** decimals).toFixed(decimals).replace(\'.\', \'\');',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-payment-page-renders-whatever-it-is-given-as-an-amount',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: "  if (!/^[0-9]+$/.test(amountAtomic)) throw new Error('an atomic amount is digits only');",
    to: '  void amountAtomic;',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-page-invents-network-parameters-for-any-chain',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: '  if (chainId === 137) {\n    return {\n      chainId: toHexChainId(137),',
    to: '  if (chainId > 0) {\n    return {\n      chainId: toHexChainId(chainId),',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'a-wallet-code-buried-in-data-is-not-read',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: '  const code = typeof e.code === \'number\' ? e.code : parseNestedCode(e);',
    to: '  const code = typeof e.code === \'number\' ? e.code : undefined;',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-page-asks-for-a-signature-on-the-wrong-network',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: `  if (s.chainId !== null && s.chainId !== s.wantChainId) return 'switch-chain';
  if (!s.walletVerified) return 'prove';`,
    to: `  if (!s.walletVerified) return 'prove';
  if (s.chainId !== null && s.chainId !== s.wantChainId) return 'switch-chain';`,
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-page-calls-a-sent-transaction-a-finished-purchase',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: "  if (s.delivered) return 'done';",
    to: "  if (s.delivered || s.reported) return 'done';",
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-page-treats-an-unasked-chain-as-the-wrong-chain',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: "  if (s.chainId !== null && s.chainId !== s.wantChainId) return 'switch-chain';",
    to: "  if (s.chainId !== s.wantChainId) return 'switch-chain';",
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-browser-is-told-about-currencies-that-are-switched-off',
    file: 'apps/api/src/services/stablecoin-tokens.ts',
    from: '  return whitelistedTokens().filter((t) => t.chainId === cfg.STABLECOIN_CHAIN_ID && on[t.key]);',
    to: '  void on;\n  return [...whitelistedTokens()];',
    tests: ['tests/stablecoin-quote-intent.test.ts'],
  },
  {
    name: 'a-wallet-listing-shows-everybodys-wallets',
    file: 'packages/db/src/stablecoin.ts',
    from: `    \`SELECT user_id, chain_id, address, challenge_id, verified_at, last_used_at
       FROM verified_wallets WHERE user_id = ? ORDER BY verified_at\`,
    [userId],`,
    to: `    \`SELECT user_id, chain_id, address, challenge_id, verified_at, last_used_at
       FROM verified_wallets ORDER BY verified_at\`,
    [],`,
    tests: ['tests/stablecoin-quote-intent.test.ts'],
  },
  {
    name: 'the-console-compares-amounts-as-numbers',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: '  const expected = BigInt(expectedAtomic);\n  const received = BigInt(receivedAtomic);',
    to: '  const expected = Number(expectedAtomic);\n  const received = Number(receivedAtomic);',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-monthly-export-uses-utc-month-boundaries',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: '  const from = Date.UTC(year, mon - 1, 1, -9, 0, 0);\n  const to = Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1, -9, 0, 0);',
    to: '  const from = Date.UTC(year, mon - 1, 1, 0, 0, 0);\n  const to = Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1, 0, 0, 0);',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-monthly-export-accepts-a-month-that-is-not-one',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: '  if (mon < 1 || mon > 12) return null;',
    to: '  void mon;',
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'support-can-decide-about-a-payment',
    file: 'apps/web/src/lib/stablecoin.ts',
    from: "  return role === 'admin';",
    to: "  return role === 'admin' || role === 'support';",
    tests: ['tests/stablecoin-pay-ui.test.ts'],
  },
  {
    name: 'the-purchase-cap-counts-orders-started-as-money-spent',
    file: 'packages/db/src/billing.ts',
    from: "       COALESCE(SUM(CASE WHEN paid_at IS NOT NULL AND paid_at >= ? AND currency = 'jpy'\n                         THEN amount_minor ELSE 0 END), 0) AS paid_jpy_minor,",
    to: "       COALESCE(SUM(CASE WHEN created_at >= ? AND currency = 'jpy'\n                         THEN amount_minor ELSE 0 END), 0) AS paid_jpy_minor,",
    tests: ['tests/purchase-cap.test.ts'],
  },
  {
    name: 'the-purchase-cap-has-no-count-limit',
    file: 'apps/api/src/services/purchase-cap.ts',
    from: '  if (countCap > 0 && activity.createdCount >= countCap) {',
    to: '  if (false && countCap > 0 && activity.createdCount >= countCap) {',
    tests: ['tests/purchase-cap.test.ts'],
  },
  {
    name: 'the-purchase-cap-exempts-a-currency-it-cannot-evaluate',
    file: 'apps/api/src/services/purchase-cap.ts',
    from: "  if (params.currency !== 'jpy' || activity.paidOtherCurrencyCount > 0) {",
    to: "  if (false && (params.currency !== 'jpy' || activity.paidOtherCurrencyCount > 0)) {",
    tests: ['tests/purchase-cap.test.ts'],
  },
  {
    name: 'the-purchase-cap-never-forgets',
    file: 'apps/api/src/services/purchase-cap.ts',
    from: '  const since = new Date(Date.now() - 86_400_000);',
    to: '  const since = new Date(0);',
    tests: ['tests/purchase-cap.test.ts'],
  },
  {
    name: 'the-purchase-cap-ignores-the-purchase-being-made',
    file: 'apps/api/src/services/purchase-cap.ts',
    from: '  if (activity.paidJpyMinor + params.amountMinor > valueCap) {',
    to: '  if (activity.paidJpyMinor > valueCap) {',
    tests: ['tests/purchase-cap.test.ts'],
  },
  {
    name: 'a-purchase-path-creates-its-order-uncapped',
    file: 'apps/api/src/services/market.ts',
    edits: [
      {
        from: "import { createPurchaseOrder } from './purchase-cap.js';",
        to: "import { createPurchaseOrder } from './purchase-cap.js';\nimport { insertOrder } from '@yuha/db';\nvoid createPurchaseOrder;",
      },
      { from: '    (await createPurchaseOrder(ctx, {', to: '    (await insertOrder({' },
    ],
    tests: ['tests/purchase-cap.test.ts'],
  },
  {
    name: 'a-held-order-is-delivered-by-the-recovery-sweep',
    file: 'apps/api/src/services/fulfilment.ts',
    from: '  if (await openOrderReview(order.id, tx)) {\n    return { delivered: false, reason: \'held_for_review\' };\n  }',
    to: '  void openOrderReview;',
    tests: ['tests/card-order-review.test.ts'],
  },
  {
    name: 'the-new-account-signal-needs-only-one-half',
    file: 'apps/api/src/services/order-review.ts',
    from: '    facts.accountAgeMs < limits.newAccountMinutes * 60_000 &&\n    facts.amountMinor >= limits.newAccountValueMinor',
    to: '    (facts.accountAgeMs < limits.newAccountMinutes * 60_000 ||\n      facts.amountMinor >= limits.newAccountValueMinor)',
    tests: ['tests/card-order-review.test.ts'],
  },
  {
    name: 'the-velocity-signal-is-off-by-one',
    file: 'apps/api/src/services/order-review.ts',
    from: '  if (limits.velocityOrders > 0 && facts.ordersStartedInWindow >= limits.velocityOrders) {',
    to: '  if (limits.velocityOrders > 0 && facts.ordersStartedInWindow > limits.velocityOrders) {',
    tests: ['tests/card-order-review.test.ts'],
  },
  {
    name: 'a-stablecoin-order-is-assessed-for-card-risk',
    file: 'apps/api/src/services/order-review.ts',
    from: "  if (params.order.payment_method === 'stablecoin') return [];",
    to: '  void params;',
    tests: ['tests/card-order-review.test.ts'],
  },
  /*
   * There was a mutation here that swapped `INSERT IGNORE` for
   * `ON DUPLICATE KEY UPDATE` in `holdOrderForReview`, and it SURVIVED — which
   * was the correct answer. The unique key, not the statement form, is what
   * stops a replayed webhook opening a second review, and the `{ held }` flag
   * the function used to return from `affectedRows` was read by nobody. The
   * fix was to delete the flag rather than to write a test for a difference
   * that does not exist; a surviving mutation is sometimes a question about
   * the code and not about the tests.
   */
  {
    name: 'a-held-order-is-not-reported-to-the-customer',
    file: 'apps/api/src/services/billing.ts',
    from: '    heldForReview: !!(await openOrderReview(order.id)),',
    to: '    heldForReview: false,',
    tests: ['tests/card-order-review.test.ts'],
  },
  {
    name: 'the-held-order-decision-can-be-taken-twice',
    file: 'packages/db/src/billing.ts',
    from: '      WHERE id = ? AND decided_at IS NULL`,\n    [params.decision, params.reason, params.actorId, params.id],',
    to: '      WHERE id = ?`,\n    [params.decision, params.reason, params.actorId, params.id],',
    tests: ['tests/card-order-review.test.ts'],
  },
  /* ---- the Stripe webhook's public path (round 4) ---------------------- */
  {
    // The failure that makes this round worth testing: a path served as a
    // route but missed by the raw-body parser rejects every real delivery as
    // unsigned, which reads exactly like a wrong secret.
    name: 'the-new-webhook-path-loses-its-raw-body',
    file: 'apps/api/src/webhook-paths.ts',
    from: "const RAW_BODY_PREFIXES = ['/api/webhooks/', '/v1/webhooks/'] as const;",
    to: "const RAW_BODY_PREFIXES = ['/v1/webhooks/'] as const;",
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // nginx without an /api/ location answers the SPA, with 200, to a signed
    // POST — and Stripe never retries a 200.
    name: 'nginx-answers-the-spa-to-the-webhook',
    file: 'deploy/dgx/app/nginx.conf',
    from: '  location /api/ {',
    to: '  location /api-disabled/ {',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    name: 'the-ingress-leaves-api-to-the-catch-all',
    file: 'infra/helm/loopscene/templates/api.yaml',
    from: '          - path: /api\n            pathType: Prefix\n',
    to: '',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  /*
   * There was a mutation here that moved the `/` catch-all to the top of the
   * ingress path list, on the belief that the ALB controller takes list order
   * as rule priority. It does not: the AWS Load Balancer Controller sorts an
   * Ingress's paths before assigning priorities (Exact first, then Prefix
   * longest first), which is also what the Ingress spec says. So that
   * mutation produces an identical ALB and would have SURVIVED correctly. The
   * comment in the chart and the assertion in the test both claimed the wrong
   * mechanism and were fixed; what actually decides it is below.
   */
  {
    // `Exact` on /api routes /api and sends /api/webhooks/stripe to the
    // catch-all — the silent failure, reachable through a one-word edit that a
    // test reading only path strings cannot see.
    name: 'the-ingress-matches-api-exactly',
    file: 'infra/helm/loopscene/templates/api.yaml',
    from: '          - path: /api\n            pathType: Prefix',
    to: '          - path: /api\n            pathType: Exact',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // proxy_pass with a URI part replaces the matched prefix, so the api is
    // asked for /webhooks/stripe — a route it does not register. Routed, and
    // still a 404.
    name: 'nginx-rewrites-the-webhook-uri',
    file: 'deploy/dgx/app/nginx.conf',
    from: `  location /api/ {
    set $api_upstream http://api:4000;
    proxy_pass $api_upstream;`,
    to: `  location /api/ {
    set $api_upstream http://api:4000;
    proxy_pass $api_upstream/;`,
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // The second copy of the event list, in the file the local-dev flow tells
    // you to fill in. Three of the four copies were missing this event.
    name: 'the-env-example-event-list-drifts',
    file: '.env.example',
    from: ',charge.dispute.closed',
    to: '',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // Present but wrong is the case that matters: 2024-06-20 is a real Stripe
    // version, older than the Checkout minimum, and discovered only by a
    // failing live purchase.
    name: 'the-api-version-floor-is-not-checked',
    file: 'apps/api/src/config.ts',
    from: "      } else if (shape[1]! < STRIPE_API_VERSION_FLOOR.slice(0, 10)) {",
    to: "      } else if (false) {",
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // A secret key pasted into the signing-secret variable verifies nothing,
    // and looks from the dashboard like our server being broken.
    name: 'any-string-is-accepted-as-the-signing-secret',
    file: 'apps/api/src/config.ts',
    from: "    if (e.STRIPE_WEBHOOK_SECRET && !e.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {",
    to: "    if (false) {",
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // charge.dispute.closed is the moment a dispute is lost and the money is
    // actually gone. Handled in code, forwarded by nothing.
    name: 'the-forwarder-never-delivers-a-lost-dispute',
    file: 'deploy/dgx/app/docker-compose.yml',
    from: ',charge.dispute.closed',
    to: '',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    name: 'the-licence-price-id-is-not-required-at-startup',
    file: 'apps/api/src/config.ts',
    from: '    if (!e.STRIPE_PRICE_ID_MARKET_LICENSE) {',
    to: '    if (false) {',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    name: 'the-licence-price-id-reaches-no-pod',
    file: 'infra/helm/loopscene/templates/configmap.yaml',
    from: '  STRIPE_PRICE_ID_MARKET_LICENSE: {{ .Values.config.stripe.priceIdMarketLicense | quote }}\n',
    to: '',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // A 200 that does not mean "saved" turns a transient database error into a
    // permanently lost payment: Stripe's three days of retries are the only
    // recovery there is.
    name: 'the-webhook-is-acknowledged-even-when-it-cannot-be-stored',
    file: 'apps/api/src/routes/billing.ts',
    from: `      payload: result.event.raw,
    });`,
    to: `      payload: result.event.raw,
    }).catch(() => ({ duplicate: false }));`,
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // Two paths, one endpoint. Keyed per path, an event forwarded to /v1 and
    // delivered to /api would be processed twice.
    name: 'the-event-dedupe-is-keyed-on-the-path',
    file: 'apps/api/src/routes/billing.ts',
    from: '      eventId: result.event.id,',
    to: '      eventId: `${req.url}:${result.event.id}`,',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    name: 'the-test-catalogue-drifts-from-the-product-catalogue',
    file: 'tests/helpers/harness.ts',
    from: "    units: 45,",
    to: '    units: 400,',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  /* ---- the customer console and the gift (round 5) --------------------- */
  {
    // `LIKE '%x%'` turns support tooling into a people search, and two
    // characters of a common domain returns the customer list.
    name: 'the-customer-search-matches-any-substring',
    file: 'packages/db/src/users.ts',
    from: '        AND email_active LIKE ?',
    to: "        AND email_active LIKE CONCAT('%', ?, '%')",
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // Unescaped, `_` is LIKE's single-character wildcard: a search for a real
    // address returns an account that is not the one the operator meant.
    name: 'an-underscore-in-an-address-is-a-wildcard',
    file: 'packages/db/src/users.ts',
    from: '    [`${escapeLike(needle)}%`, limit + 1],',
    to: '    [`${needle}%`, limit + 1],',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // Granting credits to the row an executed deletion left behind quietly
    // undoes the deletion.
    name: 'a-deleted-account-is-still-findable',
    file: 'packages/db/src/users.ts',
    from: "      WHERE status <> 'deleted'\n        AND email_active LIKE ?",
    to: '      WHERE 1 = 1\n        AND email LIKE ?',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // The per-gift cap bounds nothing on its own: fifty gifts of fifty is
    // still two and a half thousand generations of provider cost.
    name: 'the-daily-giving-limit-is-not-enforced',
    file: 'apps/api/src/services/operator-grant.ts',
    from: '    if (perDay > 0 && already + params.units > perDay) {',
    to: '    if (false) {',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    name: 'one-gift-may-carry-any-number-of-credits',
    file: 'apps/api/src/services/operator-grant.ts',
    from: '  if (params.units > perGift) {',
    to: '  if (false) {',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // A giveaway recorded as `compensation` says in the books that we broke
    // something, and leaves "how much have we given away" unanswerable.
    name: 'a-gift-is-booked-as-an-apology',
    file: 'packages/db/src/ledger.ts',
    from: "      source: 'operator_gift',",
    to: "      source: 'compensation',",
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // Support can compensate — an apology, capped at twenty. Giving credits
    // away spends money, which is a different authority.
    name: 'support-can-give-credits-away',
    file: 'apps/api/src/routes/admin.ts',
    from: "  app.post('/v1/admin/users/:id/grant', { preHandler: adminOnly }",
    to: "  app.post('/v1/admin/users/:id/grant', { preHandler: staff }",
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    name: 'a-suspended-account-can-still-be-given-credits',
    file: 'apps/api/src/services/operator-grant.ts',
    from: "  if (user.status !== 'active') {",
    // `if (false)` would be the obvious write-back and it does not compile:
    // TypeScript gives declared rather than narrowed types inside statically
    // unreachable code, so `user.status` in the throw below becomes possibly
    // undefined. A comparison it cannot fold keeps the narrowing and still
    // never fires.
    to: '  if (user.status !== user.status) {',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // An archived Price agrees on every other field and Checkout refuses it,
    // so the first symptom without this is a customer who cannot buy.
    name: 'an-archived-stripe-price-passes-the-check',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: "  if (!remote.active) mismatch('active', 'active', 'archived');",
    to: '  void 0;',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // A one-off configured as recurring bills the customer every month for
    // ever. Worse than a wrong amount.
    name: 'the-billing-interval-is-not-compared',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '  if ((remote.interval ?? null) !== row.interval) {',
    // Not `if (false)`: inside statically unreachable code TypeScript drops
    // the narrowing from the `if (!remote) return` above, and the build fails
    // instead of the test. A comparison it cannot fold keeps it.
    to: '  if (row.interval !== row.interval) {',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // A tiered Price reports null, and skipping it reports agreement about a
    // price we cannot read.
    name: 'a-tiered-price-is-skipped-rather-than-refused',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '  if (remote.amountMinor !== row.amountMinor) {',
    to: '  if (remote.amountMinor !== null && remote.amountMinor !== row.amountMinor) {',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // "Could not check" reported as "nothing is wrong".
    name: 'an-uncheckable-catalogue-reports-agreement',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '  if (!retrieve) return null;',
    to: '  if (!retrieve) return [];',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // The mismatch report without the Stripe product name reads as "somebody
    // mistyped a price" rather than "these two are the wrong way round".
    name: 'the-mismatch-does-not-name-the-stripe-product',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: "  const who = p.stripeProduct ? ` (Stripe calls it \"${p.stripeProduct}\")` : '';",
    to: "  const who = '';",
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // Two variables holding one id: every row agrees with the Price it
    // matches and the other reports a wrong amount, which sends the operator
    // to fix the amount instead of the id.
    name: 'one-price-id-used-twice-is-not-reported-as-such',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '    if (group.length < 2) continue;',
    to: '    if (true) continue;',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  /* ---- round 5, second pass: what the independent review found --------- */
  {
    // The gift's daily cap without a lock on the operator's own row is a
    // suggestion: two requests to two recipients take two different recipient
    // locks, both read the same stale total, and both commit. Measured at 50
    // parallel requests writing 5,000 units against a 500-a-day limit.
    name: 'the-daily-cap-is-read-without-locking-the-operator',
    file: 'apps/api/src/services/operator-grant.ts',
    from: '    await lockUser(params.actorId, tx);',
    to: '',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // Compensation is 20 per call and was unbounded per day, while the gift
    // cap was being documented as the compromised-account protection.
    name: 'compensation-has-no-daily-limit',
    file: 'apps/api/src/routes/admin.ts',
    from: '      const perDay = ctx.config.ADMIN_COMPENSATION_MAX_UNITS_PER_DAY;',
    to: '      const perDay = 0;',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // A Price billed every second month agrees on every other field and bills
    // half as often as the catalogue says.
    name: 'a-price-billed-every-second-month-passes',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '  if (row.interval !== null && (remote.intervalCount ?? 1) !== 1) {',
    // `&& false` makes the block unreachable and TypeScript then drops the
    // narrowing from the `if (!remote) return` above — the trap in this file's
    // header. A comparison it cannot fold keeps it.
    to: '  if (row.interval !== null && row.interval !== row.interval) {',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // tax_behavior: exclusive charges tax on top of the ¥980 the page promised.
    name: 'a-price-that-adds-tax-on-top-passes',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: "  if (row.taxIncluded && remote.taxBehavior === 'exclusive') {",
    to: "  if (row.taxIncluded && remote.taxBehavior === 'never-this') {",
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // A 429 or an outage reported as "that id does not exist", which the seed
    // then exits on with four accusations about correct values.
    name: 'a-stripe-outage-is-reported-as-a-wrong-id',
    file: 'packages/providers/src/payments/stripe.ts',
    from: "      if ((err as { type?: string }).type === 'StripeInvalidRequestError') return null;\n      throw err;",
    to: '      void err;\n      return null;',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // "Could not check" and "nothing is wrong" are different answers.
    name: 'an-unset-price-id-blocks-a-seed-that-does-not-sell-it',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: "    p.kind === 'mismatch' || p.kind === 'unreadable' || p.kind === 'duplicate' || p.kind === 'stale'",
    to: "    p.kind !== 'unavailable'",
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // Two Prices under one Stripe product: two different ids, so comparing
    // ids sees nothing. This is what "I made a new CREATOR Price and pasted
    // it into the STUDIO slot" looks like.
    name: 'two-prices-of-one-stripe-product-are-not-noticed',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: "    ...shared(rows, (row) => fetched.get(row.envVar)?.productId ?? null, 'product').filter(",
    // Grouping on the Price id instead of the product id: the pass still
    // runs, and can then only ever restate what the price pass already found,
    // so two DISTINCT ids under one product go unnoticed.
    to: "    ...shared(rows, (row) => fetched.get(row.envVar)?.id ?? null, 'product').filter(",
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // The search was a full table scan with a filesort because it matched
    // `email`, which has no index; `email_active` is the indexed column and
    // excludes deleted rows by construction.
    name: 'the-customer-search-stops-using-the-index',
    file: 'packages/db/src/users.ts',
    from: "        AND email_active LIKE ?\n      ORDER BY email_active ASC",
    to: "        AND email LIKE ?\n      ORDER BY email ASC",
    tests: ['tests/operator-grant.test.ts'],
  },
  /* ---- the Google callback address (round 6) --------------------------- */
  {
    // The whole check. Google refuses on its own page with nothing on our
    // side to look at, so a wrong value has to be refused at boot.
    name: 'the-google-redirect-uri-is-only-checked-for-presence',
    file: 'apps/api/src/config.ts',
    from: '        if (parsed.pathname !== GOOGLE_CALLBACK_PATH) {',
    to: '        if (parsed.pathname !== parsed.pathname) {',
    tests: ['tests/google-redirect-uri.test.ts'],
  },
  {
    // A host carried over from the previous deployment: the AWS-migration
    // failure, and the one nothing else would notice.
    name: 'the-google-redirect-uri-may-point-at-another-host',
    file: 'apps/api/src/config.ts',
    from: '        if (parsed.origin !== apiOrigin) {',
    to: '        if (parsed.origin !== parsed.origin) {',
    tests: ['tests/google-redirect-uri.test.ts'],
  },
  {
    // The API's callback path and the SPA's return path are different routes,
    // and handing Google the second is the mistake that reads as reasonable.
    name: 'the-api-registers-the-web-apps-callback-path',
    file: 'apps/api/src/auth/google-paths.ts',
    from: "export const GOOGLE_CALLBACK_PATH = '/v1/auth/google/callback';",
    to: "export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';",
    tests: ['tests/google-redirect-uri.test.ts'],
  },
  /* ---- round 6: what the full review found ----------------------------- */
  {
    // The raw-body rule read `req.url`, which keeps what the client sent,
    // while find-my-way matches the DECODED path — so
    // `/api/%77ebhooks/stripe` was routed to the webhook with its body parsed
    // away, 400'd before any audit row was written, and gave an
    // unauthenticated caller the one error message the post-deploy check uses.
    name: 'the-raw-body-rule-reads-the-unmatched-url',
    file: 'apps/api/src/server.ts',
    from: '      if (keepsRawBody(req.routeOptions?.url ?? undefined)) {',
    to: '      if (keepsRawBody(req.url)) {',
    tests: ['tests/stripe-webhook-path.test.ts'],
  },
  {
    // `${PUBLIC_WEB_URL}${successPath}` with `@evil.example/` produces a real
    // Stripe Checkout link for this account that returns the payer to
    // somebody else's host.
    name: 'the-checkout-success-path-is-concatenated',
    file: 'apps/api/src/services/billing.ts',
    from: `      const base = internalUrl(
        ctx.config.PUBLIC_WEB_URL,
        params.successPath ?? '/checkout/complete',
        '/checkout/complete',
      );`,
    to: "      const base = `${ctx.config.PUBLIC_WEB_URL}${params.successPath ?? '/checkout/complete'}`;",
    tests: ['tests/checkout-redirect.test.ts'],
  },
  {
    // Login CSRF: the state was self-contained, so a callback URL captured by
    // an attacker signs the victim into the attacker's account.
    name: 'the-oauth-state-is-not-bound-to-a-browser',
    file: 'apps/api/src/routes/auth.ts',
    from: '      if (!cookie || expected.length !== got.length || !timingSafeEqual(expected, got)) {',
    to: '      if (false) {',
    tests: ['tests/google-login-csrf.test.ts'],
  },
  {
    // The redirect-URI and session-secret checks were gated on the adapter
    // while the flow is gated on credentials, so the dev+google combination
    // `.env.example` ships had a live endpoint and no validation.
    name: 'the-google-checks-are-gated-on-the-adapter',
    file: 'apps/api/src/config.ts',
    from: '  if (googleFlowLive && googleRedirect) {',
    to: "  if (googleFlowLive && googleRedirect && adapters.auth === 'google') {",
    tests: ['tests/google-redirect-uri.test.ts'],
  },
  {
    // A metered Price carries a non-null unit_amount and bills nothing, so a
    // subscription invoice arrives paid at zero and grants a free month.
    name: 'a-metered-price-passes-the-check',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: "  if (remote.usageType && remote.usageType !== 'licensed') {",
    to: '  if (remote.usageType === remote.taxBehavior) {',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // An archived product behind an active Price agrees on every field and
    // Stripe refuses the Checkout Session.
    name: 'an-archived-stripe-product-passes-the-check',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '  if (remote.productActive === false) {',
    to: '  if (remote.productActive === null) {',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // Checkout reads product_catalog.stripe_price_id, not the environment
    // variable, so a price-id change without a re-seed keeps selling the old
    // Price while the check prints a tick.
    name: 'the-stored-catalogue-id-is-not-compared',
    file: 'apps/api/src/services/stripe-catalogue.ts',
    from: '    if ((db.stripe_price_id ?? null) === (row.priceId ?? null)) continue;',
    // A comparison the compiler cannot fold, so the block below keeps the
    // narrowing from `if (!db) continue` above — `if (true) continue` makes it
    // unreachable and the build fails instead of the test, which is the trap
    // in this file's header.
    to: '    if (row.priceKey === row.priceKey) continue;',
    tests: ['tests/stripe-catalogue.test.ts'],
  },
  {
    // A reason longer than ledger_entries.reason (VARCHAR(255)) raised
    // ER_DATA_TOO_LONG, which is not an AppError — a bare 500, and then a
    // retry.
    name: 'the-credit-reason-may-be-longer-than-the-column',
    file: 'apps/api/src/routes/admin.ts',
    from: '  const ledgerReasoned = z.object({ reason: z.string().min(5).max(200) });',
    to: '  const ledgerReasoned = z.object({ reason: z.string().min(5).max(500) });',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // The gift path had no replay protection at any layer, and a lost
    // response is an ordinary event.
    name: 'a-retried-gift-is-a-second-gift',
    file: 'packages/db/src/ledger.ts',
    from: '      sourceRef: params.idempotencyKey ? `gift:${params.idempotencyKey}` : `gift:${newId()}`,',
    to: '      sourceRef: `gift:${newId()}`,',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // compensate is open to support and had neither the uuid check nor the
    // deleted/suspended refusal that grant has.
    name: 'compensation-may-credit-a-deleted-account',
    file: 'apps/api/src/routes/admin.ts',
    // Only the deleted/suspended half is written out; `!recipient` keeps
    // throwing so the narrowing below survives and the build is about the
    // defect rather than about TypeScript.
    from: "      if (!recipient || recipient.status === 'deleted' || recipient.deleted_at) {",
    to: '      if (!recipient) {',
    tests: ['tests/operator-grant.test.ts'],
  },
  {
    // A customer's address in a query string, logged at info by Fastify and
    // recorded in nginx's and an ALB's access log.
    name: 'a-customer-email-is-logged-in-the-url',
    file: 'apps/api/src/log-redaction.ts',
    from: "  'email',\n]);",
    to: ']);',
    tests: ['tests/log-url-redaction.test.ts'],
  },
  /*
   * There was a mutation here for `recordWebhookEvent`'s new `if (!row) throw`
   * — written back as the old `return { row: {} as WebhookEventRow, duplicate:
   * true }` — and it SURVIVED, which is the correct answer.
   *
   * `INSERT IGNORE` downgrades every error to a warning, so a row refused for
   * a reason other than a duplicate key reported `duplicate: true` with no row
   * behind it, and the webhook route answered 200 to it: charged,
   * acknowledged, nothing granted. But nothing Stripe can send reaches that
   * branch. `event_id` is VARCHAR(191) against 28-character `evt_…` ids,
   * `event_type` is VARCHAR(128) against types under 60, `provider` is a
   * literal, and the table has no CHECK and no foreign key — and a data-too-
   * long value would be TRUNCATED and then found, not missing. So the branch
   * is defensive against a state the schema does not permit.
   *
   * The throw stays, because it converts a structurally impossible state into
   * a 5xx and a Stripe redelivery rather than a wrong 200, and because the
   * previous code's correctness rested on a non-null assertion. What is not
   * kept is a mutation no test can kill: that is a dead entry, and a dead
   * entry reads exactly like a passing one — the thing `--anchors` exists to
   * stop. Same judgement as the `holdOrderForReview` entry above.
   */
  {
    name: 'a-blank-numeric-config-line-is-zero-again',
    file: 'apps/api/src/config.ts',
    from: "const blank = (v: string | undefined) => v === undefined || v.trim() === '';",
    to: "const blank = (v: string | undefined) => v === undefined;",
    tests: ['tests/stablecoin-config.test.ts'],
  },
];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
}

function cleanTree() {
  const out = sh('git', ['status', '--porcelain']);
  return out.trim() === '';
}

function buildFor(files) {
  const filters = new Set();
  for (const f of files) {
    if (f.startsWith('packages/db')) filters.add('@yuha/db');
    if (f.startsWith('packages/providers')) filters.add('@yuha/providers');
    if (f.startsWith('packages/contracts')) filters.add('@yuha/contracts');
  }
  // The API is always rebuilt: the harness boots the server from dist even
  // though tests import services from src, so a mutation that is not built
  // would be half-applied — the most misleading state of all.
  const order = ['@yuha/contracts', '@yuha/db', '@yuha/providers'].filter((f) => filters.has(f));
  for (const f of [...order, '@yuha/api', '@yuha/worker']) {
    try {
      sh('pnpm', ['-s', '--filter', f, 'build']);
    } catch (e) {
      return `BUILD FAILED (${f}): ${String(e.stdout ?? '').slice(-400)}`;
    }
  }
  return null;
}

/*
 * `--anchors`: check that every mutation's `from` text still exists in its
 * file, and nothing else. Fast, no build, no database.
 *
 * This exists because four mutations in this file had silently stopped
 * testing anything. A refactor moves the line a mutation was written against,
 * the `from` no longer matches, and the run prints ANCHOR NOT FOUND — which
 * is easy to miss in a list of ninety, and invisible if nobody runs the full
 * set. A dead mutation reads exactly like a passing one.
 *
 * It also found two defects sitting in the working tree, left there by
 * interrupted runs (see the fourth trap in the header): their anchors no
 * longer matched because the files held the mutated form.
 * `tests/mutation-anchors.test.ts` runs this on every `pnpm test`.
 */
if (process.argv[2] === '--anchors') {
  let missing = 0;
  let checked = 0;
  for (const m of MUTATIONS) {
    const text = readFileSync(join(ROOT, m.file), 'utf8');
    for (const e of m.edits ?? [{ from: m.from }]) {
      checked += 1;
      if (!e.from || !text.includes(e.from)) {
        console.error(`ANCHOR NOT FOUND  ${m.name}\n  ${m.file}\n  looked for: ${JSON.stringify(e.from)}`);
        missing += 1;
        continue;
      }
      /*
       * And it must appear exactly ONCE. `String.replace` with a string
       * pattern replaces the first occurrence, so an anchor that a refactor
       * has duplicated applies the defect to whichever copy comes first —
       * which may not be the one the mutation is about, leaving a mutation
       * that passes while testing the wrong line.
       */
      if (text.split(e.from).length - 1 > 1) {
        console.error(
          `ANCHOR NOT UNIQUE  ${m.name}\n  ${m.file}\n  appears ${text.split(e.from).length - 1} times: ${JSON.stringify(e.from)}`,
        );
        missing += 1;
      }
    }
  }
  if (missing > 0) {
    console.error(`\n${missing} mutation anchor(s) no longer apply or are ambiguous. Each one is a test nobody is running.`);
    process.exit(1);
  }
  // The number of ANCHORS, not of mutations: one entry carries two edits, and
  // reporting the mutation count overstated what was checked by one.
  console.log(`✓ ${checked} mutation anchors all still match their files, uniquely`);
  process.exit(0);
}

const only = process.argv[2] === '--repair' ? undefined : process.argv[2];
const repairOnly = process.argv[2] === '--repair';
const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;

mkdirSync(PRISTINE, { recursive: true });

/*
 * Put back whatever an interrupted run left behind, before anything else.
 *
 * `IN_FLIGHT` names the mutation currently written into the tree. It is
 * created before the file is modified and removed after the file is restored,
 * so its presence means a previous process died in between — and the pristine
 * copy beside it is the file as it was.
 */
const IN_FLIGHT = join(PRISTINE, 'in-flight.json');
if (existsSync(IN_FLIGHT)) {
  const stale = JSON.parse(readFileSync(IN_FLIGHT, 'utf8'));
  const backup = join(PRISTINE, stale.file.replaceAll('/', '_'));
  const current = existsSync(join(ROOT, stale.file)) ? readFileSync(join(ROOT, stale.file), 'utf8') : '';
  /*
   * Restored ONLY if the file is still mutated.
   *
   * This used to copy the backup over the file unconditionally, which makes
   * this the one script in the repository licensed to destroy uncommitted
   * work: interrupt a run, restore the file by hand, spend an hour editing
   * it, and the next run stamps a stale backup over the lot and prints
   * "repaired". `/tmp/mutation-pristine` is never cleaned, so the window is
   * not short either.
   *
   * The marker records the mutation's own `to` text, so "still mutated" is a
   * question with an answer rather than an assumption. If the defect is gone,
   * somebody already dealt with it and the only correct action is to say so
   * and leave the file alone.
   */
  const stillMutated = (stale.markers ?? []).length > 0 && stale.markers.every((m) => current.includes(m));
  if (!existsSync(backup)) {
    console.log(
      `WARNING: "${stale.name}" was interrupted and no pristine copy of ${stale.file} survives.\n` +
        `  Check it against git before trusting this tree.`,
    );
    /*
     * And do NOT fall through to re-baselining: line below copies each target
     * into PRISTINE, so a still-mutated file would become the new "pristine"
     * copy and a later repair would restore the defect.
     */
    rmSync(IN_FLIGHT, { force: true });
    console.log('  refusing to continue — run `git status` first, then re-run.');
    process.exit(1);
  } else if (!stillMutated) {
    console.log(
      `"${stale.name}" was interrupted, but ${stale.file} no longer carries its defect —\n` +
        `  somebody restored it already. Leaving the file alone.`,
    );
  } else {
    copyFileSync(backup, join(ROOT, stale.file));
    console.log(`repaired: ${stale.file} was left mutated by "${stale.name}" and has been restored`);
    const problem = buildFor([stale.file]);
    if (problem) console.log(`  rebuild after repair: ${problem}`);
  }
  rmSync(IN_FLIGHT, { force: true });
}
if (repairOnly) process.exit(0);

const touched = [...new Set(selected.map((m) => m.file))];
for (const f of touched) copyFileSync(join(ROOT, f), join(PRISTINE, f.replaceAll('/', '_')));

const results = [];
for (const m of selected) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const edits = m.edits ?? [{ from: m.from, to: m.to }];
  if (!edits.every((e) => original.includes(e.from))) {
    results.push([m.name, 'ANCHOR NOT FOUND']);
    continue;
  }
  let mutated = original;
  for (const e of edits) mutated = mutated.replace(e.from, e.to);
  // Written BEFORE the file, so an interruption is always recoverable. The
  // `to` texts let the repair check whether the defect is still there rather
  // than assuming it is.
  writeFileSync(
    IN_FLIGHT,
    JSON.stringify({ name: m.name, file: m.file, markers: edits.map((e) => e.to).filter(Boolean) }),
  );
  writeFileSync(path, mutated);

  const buildProblem = buildFor([m.file]);
  let verdict;
  if (buildProblem) {
    verdict = buildProblem.split('\n')[0];
  } else {
    try {
      sh('pnpm', ['-s', 'vitest', 'run', ...m.tests], { env: { ...process.env, TEST_DATABASE_URL: DB } });
      verdict = 'SURVIVED';
    } catch (e) {
      const out = String(e.stdout ?? '') + String(e.stderr ?? '');
      const failed = [...out.matchAll(/^\s+×\s+(.*?)(?: \d+ms)?$/gm)].map((x) => x[1]);
      verdict = `KILLED by ${failed.length} test(s): ${failed.slice(0, 2).join(' | ') || 'see log'}`;
    }
  }
  // Restored from the pristine copy, never with git checkout.
  copyFileSync(join(PRISTINE, m.file.replaceAll('/', '_')), path);
  rmSync(IN_FLIGHT, { force: true });
  results.push([m.name, verdict]);
  console.log(`${verdict.startsWith('KILLED') ? 'ok  ' : 'FAIL'} ${m.name}\n     ${verdict}`);
}

const problem = buildFor(touched);
if (problem) console.log(`\nrestore build: ${problem}`);
console.log(`\ntree clean after restore: ${cleanTree()}`);
const survived = results.filter(([, v]) => !v.startsWith('KILLED'));
console.log(`\n${results.length - survived.length}/${results.length} mutations killed`);
for (const [n, v] of survived) console.log(`  NOT KILLED  ${n}: ${v}`);
