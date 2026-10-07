/**
 * What the configuration refuses to start with.
 *
 * These are not validation niceties. Each one is a state where the system
 * would run and look correct while a safety property quietly did not hold, so
 * refusing to start is the behaviour under test.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@yuha/api';

const base: Record<string, string> = {
  RUN_MODE: 'demo',
  NODE_ENV: 'test',
  DATABASE_URL: 'mysql://loopscene:loopscene_local_test@localhost:53307/loopscene_test',
  DEV_AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  STORAGE_SIGNING_SECRET: 'test-signing-0123456789abcdef0123456789abcd',
  PUBLIC_WEB_URL: 'http://localhost:5173',
  PUBLIC_API_URL: 'http://localhost:4000',
};

const RPC_A = 'https://polygon.example-a.test/v1/rpc/key-a';
const RPC_B = 'https://polygon.example-b.test/v1/rpc/key-b';
const RECEIVER = '0x9999999999999999999999999999999999999999';

const on = (over: Record<string, string> = {}) =>
  loadConfig({
    ...base,
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: RPC_A,
    POLYGON_RPC_SECONDARY_URL: RPC_B,
    ...over,
  });

describe('a blank line in a config file', () => {
  /*
   * No test passed `''` to a `num()` field at all, so restoring the old
   * behaviour — `Number('')` is 0 — survived the whole suite. It is not a
   * cosmetic defect: `STABLECOIN_SCAN_OVERLAP=` silently becoming 0 turns off
   * the overlap re-read, which is how a reorg near the head gets noticed, and
   * `STABLECOIN_QUOTE_TTL_SECONDS=` fails startup with a message about
   * arithmetic for a line somebody left empty on purpose.
   */
  it('means "take the default", not zero', () => {
    expect(on({ STABLECOIN_QUOTE_TTL_SECONDS: '' }).STABLECOIN_QUOTE_TTL_SECONDS).toBe(600);
    expect(on({ STABLECOIN_SCAN_OVERLAP: '' }).STABLECOIN_SCAN_OVERLAP).toBe(32);
    expect(on({ STABLECOIN_SCAN_MAX_SPAN: '' }).STABLECOIN_SCAN_MAX_SPAN).toBe(450);
    expect(on({ STABLECOIN_CHAIN_ID: '' }).STABLECOIN_CHAIN_ID).toBe(137);
    expect(on({ STABLECOIN_INTENT_GRACE_SECONDS: '' }).STABLECOIN_INTENT_GRACE_SECONDS).toBe(900);
  });

  it('is still a blank line when it has a space in it', () => {
    // `Number(' ')` is 0, so the fix for the empty string stopped one
    // character short of the thing editors and heredocs actually produce.
    expect(on({ STABLECOIN_SCAN_OVERLAP: '  ' }).STABLECOIN_SCAN_OVERLAP).toBe(32);
    expect(on({ STABLECOIN_SCAN_START_BLOCK: ' ' }).STABLECOIN_SCAN_START_BLOCK).toBeUndefined();
  });

  it('does not stop a real value from being read', () => {
    expect(on({ STABLECOIN_SCAN_OVERLAP: '7' }).STABLECOIN_SCAN_OVERLAP).toBe(7);
    expect(on({ STABLECOIN_SCAN_START_BLOCK: '0' }).STABLECOIN_SCAN_START_BLOCK).toBe(0);
  });

  it('keeps the grace period above one scan interval', () => {
    // The floor exists because the grace must cover finality plus a pass; a
    // grace shorter than the interval is the defect it was added to fix.
    expect(() => on({ STABLECOIN_INTENT_GRACE_SECONDS: '5' })).toThrow();
  });
});

describe('stablecoin configuration', () => {
  it('starts when both nodes and a receiver are set', () => {
    const cfg = on();
    expect(cfg.STABLECOIN_ENABLED).toBe(true);
    expect(cfg.POLYGON_RPC_PRIMARY_URL).toBe(RPC_A);
  });

  it('refuses the same URL twice — a node cannot disagree with itself', () => {
    /*
     * The failure this prevents is not an outage. With one endpoint behind
     * both names, "hold when the two nodes disagree" is a line that always
     * passes, and the system reports a safety property it does not have.
     */
    expect(() => on({ POLYGON_RPC_SECONDARY_URL: RPC_A })).toThrow(/cannot disagree with itself/);
  });

  it('refuses to run with only one node configured', () => {
    expect(() => on({ POLYGON_RPC_SECONDARY_URL: '' })).toThrow(/POLYGON_RPC_PRIMARY_URL and POLYGON_RPC_SECONDARY_URL/);
  });

  it('refuses to run with no receiving wallet', () => {
    expect(() => on({ STABLECOIN_RECEIVER_ADDRESS: '' })).toThrow(/RECEIVER_ADDRESS is required/);
  });

  it('refuses a receiver that is not an address', () => {
    expect(() => on({ STABLECOIN_RECEIVER_ADDRESS: '0xnope' })).toThrow(/not an Ethereum address/);
  });

  it('refuses USDC, which has no rate provider', () => {
    // Enabling it would mean quoting a JPY price from a constant.
    expect(() => on({ STABLECOIN_USDC_ENABLED: 'true' })).toThrow(/USDC is not quotable yet/);
  });

  it('refuses to be enabled with no currency at all', () => {
    expect(() => on({ STABLECOIN_JPYC_ENABLED: 'false' })).toThrow(/no currency is/);
  });

  it('needs none of it when the feature is off, which is the default', () => {
    const cfg = loadConfig(base);
    expect(cfg.STABLECOIN_ENABLED).toBe(false);
    expect(cfg.POLYGON_RPC_PRIMARY_URL).toBeUndefined();
  });
});
