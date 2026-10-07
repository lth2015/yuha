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
 *     verbatim before the run and copied back after, and the tree is required
 *     to be clean between mutations.
 *
 * Usage: node scripts/mutation-check.mjs [name-substring]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PRISTINE = '/tmp/mutation-pristine';
const DB = process.env.TEST_DATABASE_URL ?? 'mysql://loopscene:loopscene_local_test@localhost:53307/loopscene_test_a';

const S = 'apps/api/src/services';
const P = 'packages/providers/src/chain';

/** @type {Array<{name:string,file:string,from:string,to:string,tests:string[]}>} */
const MUTATIONS = [
  {
    name: 'orphan-write-takes-the-anti-replay-key',
    file: `${S}/stablecoin-settle.ts`,
    from: '      await recordOrphanTransfer(',
    to: `      await recordTransferEvent(
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

const only = process.argv[2];
const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;

mkdirSync(PRISTINE, { recursive: true });
const touched = [...new Set(selected.map((m) => m.file))];
for (const f of touched) copyFileSync(join(ROOT, f), join(PRISTINE, f.replaceAll('/', '_')));

const results = [];
for (const m of selected) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.from)) {
    results.push([m.name, 'ANCHOR NOT FOUND']);
    continue;
  }
  writeFileSync(path, original.replace(m.from, m.to));

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
  results.push([m.name, verdict]);
  console.log(`${verdict.startsWith('KILLED') ? 'ok  ' : 'FAIL'} ${m.name}\n     ${verdict}`);
}

const problem = buildFor(touched);
if (problem) console.log(`\nrestore build: ${problem}`);
console.log(`\ntree clean after restore: ${cleanTree()}`);
const survived = results.filter(([, v]) => !v.startsWith('KILLED'));
console.log(`\n${results.length - survived.length}/${results.length} mutations killed`);
for (const [n, v] of survived) console.log(`  NOT KILLED  ${n}: ${v}`);
