import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatMoney, useSession } from '../lib/session';
import { LOCALES } from '../lib/money';
import {
  countdown,
  explorerTxUrl,
  formatAtomic,
  knownChainParams,
  parseChainId,
  payStep,
  pollDelayMs,
  secondsLeft,
  toHexChainId,
  walletProblem,
  type WalletProblem,
} from '../lib/stablecoin';
import { ErrorNotice, Loading } from '../components/common';

/**
 * Paying in a stablecoin, from the browser.
 *
 * The shape of this page follows from one fact: there is no receiving contract
 * and no server-held key, so the only thing that moves money is the customer's
 * own wallet signing a plain ERC-20 `transfer`. Everything this page does is
 * therefore either asking the wallet for something or asking our server what
 * it has seen on the chain — it never decides that a payment happened.
 *
 * What it will not do:
 *
 *   - It does not announce success because a transaction was sent. A sent
 *     transaction can revert, land short, or sit in a block that is not final.
 *     `done` is delivery, read back from the server.
 *   - It does not carry its own copy of the amount, the token address, the
 *     receiver or the chain. All four come from the quote, which is what the
 *     server will verify against; a client-side copy of any of them is a
 *     second source of truth about where money goes.
 *   - It does not ask for a signature until the wallet is on the right
 *     network, because that prompt cannot lead anywhere.
 *
 * The decisions live in `lib/stablecoin.ts` as pure functions, tested without
 * a browser. This file renders them.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * The injected wallet, if the browser has one.
 *
 * Read through a function rather than captured once: an extension can inject
 * late, and a page that decided "no wallet" at module load would tell somebody
 * with MetaMask installed to go and install MetaMask.
 */
function injectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { ethereum?: Eip1193Provider };
  return w.ethereum ?? null;
}

interface QuoteResponse {
  orderId: string;
  quoteId: string;
  chainId: number;
  tokenKey: string;
  tokenAddress: string;
  tokenDecimals: number;
  amountAtomic: string;
  priceJpy: number;
  receiver: string;
  payer: string;
  expiresAt: string;
  roundedUp: boolean;
}

interface PreparedTransfer {
  chainId: number;
  to: string;
  data: string;
  value: '0';
  amountAtomic: string;
  receiver: string;
  expiresAt: string;
  predictedNonce: number | null;
}

interface PaymentStatusResponse {
  orderId: string;
  orderStatus: string;
  paymentMethod: string | null;
  entitlementGranted: boolean;
  intent: { state: string; expiresAt: string | null } | null;
}

interface VerifiedWallet {
  address: string;
  chainId: number;
}

export function StablecoinPay() {
  const [params] = useSearchParams();
  const priceKey = params.get('price') ?? 'drop_5';
  const trackId = params.get('track');
  const { runtime, refreshEntitlements } = useSession();
  const { t, lang } = useI18n();

  const stablecoin = runtime?.stablecoin;
  const wantChainId = stablecoin?.chainId ?? 0;
  const tokens = stablecoin?.tokens ?? [];

  const [hasProvider, setHasProvider] = useState(() => injectedProvider() !== null);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [verified, setVerified] = useState<VerifiedWallet[]>([]);
  const [tokenKey, setTokenKey] = useState<string>(() => tokens[0]?.key ?? 'jpyc');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [typedHash, setTypedHash] = useState('');
  const [status, setStatus] = useState<PaymentStatusResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<WalletProblem | null>(null);
  const [idempotencyKey] = useState(() => newIdempotencyKey('scpay'));

  // The token choice can only be one the server says is on; a stale default
  // would ask for a quote in a currency this deployment has switched off.
  useEffect(() => {
    if (tokens.length > 0 && !tokens.some((x) => x.key === tokenKey)) setTokenKey(tokens[0]!.key);
  }, [tokens, tokenKey]);

  /** Everything that can go wrong with a wallet becomes a dictionary key. */
  const fromWallet = useCallback((err: unknown) => {
    setProblem(walletProblem(err));
    setError(null);
  }, []);

  const fromServer = useCallback((err: unknown) => {
    setProblem(null);
    setError(err);
  }, []);

  // A late-injecting extension, and the wallet changing its mind about which
  // account or chain it is on while this page is open.
  useEffect(() => {
    const p = injectedProvider();
    setHasProvider(p !== null);
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const next = (args[0] as string[] | undefined)?.[0];
      setAccount(next ? next.toLowerCase() : null);
      // A different account is a different wallet: nothing quoted for the old
      // one may be presented as the new one's payment.
      setQuote(null);
      setTxHash(null);
    };
    const onChain = (...args: unknown[]) => setChainId(parseChainId(args[0]));
    p.on('accountsChanged', onAccounts);
    p.on('chainChanged', onChain);
    return () => {
      p.removeListener?.('accountsChanged', onAccounts);
      p.removeListener?.('chainChanged', onChain);
    };
  }, []);

  const loadWallets = useCallback(async () => {
    const res = await apiFetch<{ wallets: VerifiedWallet[] }>('/v1/payments/stablecoin/wallets');
    setVerified(res.wallets.map((w) => ({ ...w, address: w.address.toLowerCase() })));
  }, []);

  useEffect(() => {
    void loadWallets().catch(() => undefined);
  }, [loadWallets]);

  const walletVerified = useMemo(
    () => !!account && verified.some((w) => w.address === account && w.chainId === wantChainId),
    [account, verified, wantChainId],
  );

  const step = payStep({
    hasProvider,
    account,
    chainId,
    wantChainId,
    walletVerified,
    hasQuote: !!quote,
    reported: !!txHash,
    orderStatus: status?.orderStatus ?? null,
    delivered: !!status?.entitlementGranted,
  });

  // A clock, so the quote's remaining time is honest rather than drawn once.
  useEffect(() => {
    if (!quote || step === 'done') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote, step]);

  const left = quote ? secondsLeft(quote.expiresAt, now) : 0;
  const expired = !!quote && left === 0 && step !== 'waiting' && step !== 'done';

  /* ----------------------------------------------------------- the actions */

  const connect = async () => {
    const p = injectedProvider();
    if (!p) {
      setHasProvider(false);
      return;
    }
    setBusy('connect');
    setProblem(null);
    try {
      const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
      const first = accounts[0];
      if (!first) {
        setProblem('rejected');
        return;
      }
      setAccount(first.toLowerCase());
      setChainId(parseChainId(await p.request({ method: 'eth_chainId' })));
    } catch (err) {
      fromWallet(err);
    } finally {
      setBusy(null);
    }
  };

  const switchChain = async () => {
    const p = injectedProvider();
    if (!p) return;
    setBusy('switch');
    setProblem(null);
    try {
      await p.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: toHexChainId(wantChainId) }],
      });
      setChainId(parseChainId(await p.request({ method: 'eth_chainId' })));
    } catch (err) {
      /*
       * 4902 means the wallet has never heard of this network, which is
       * ordinary. Adding it is offered only for a chain whose parameters are
       * checked into this repository — a fabricated RPC URL would be a lasting
       * piece of wrong configuration left in somebody's wallet.
       */
      if (walletProblem(err) === 'unknownChain') {
        const chain = knownChainParams(wantChainId);
        if (!chain) {
          setProblem('unknownChain');
          return;
        }
        try {
          await p.request({ method: 'wallet_addEthereumChain', params: [chain] });
          setChainId(parseChainId(await p.request({ method: 'eth_chainId' })));
          return;
        } catch (addErr) {
          fromWallet(addErr);
          return;
        }
      }
      fromWallet(err);
    } finally {
      setBusy(null);
    }
  };

  const prove = async () => {
    const p = injectedProvider();
    if (!p || !account) return;
    setBusy('prove');
    setProblem(null);
    try {
      const challenge = await apiFetch<{ nonce: string; message: string }>(
        '/v1/payments/stablecoin/wallet-challenge',
        { method: 'POST', body: { address: account, chainId: wantChainId } },
      );
      // personal_sign, which is what the server recovers the address from.
      const signature = (await p.request({
        method: 'personal_sign',
        params: [challenge.message, account],
      })) as string;
      await apiFetch('/v1/payments/stablecoin/wallet-verify', {
        method: 'POST',
        body: { nonce: challenge.nonce, address: account, signature },
      });
      await loadWallets();
    } catch (err) {
      if (err instanceof ApiError) fromServer(err);
      else fromWallet(err);
    } finally {
      setBusy(null);
    }
  };

  const takeQuote = async () => {
    if (!account) return;
    setBusy('quote');
    setProblem(null);
    setError(null);
    try {
      const res = await apiFetch<QuoteResponse>('/v1/payments/stablecoin/quote', {
        method: 'POST',
        body: {
          priceKey,
          idempotencyKey,
          tokenKey,
          payer: account,
          ...(trackId ? { trackId } : {}),
        },
      });
      setQuote(res);
      setNow(Date.now());
      setStatus(null);
    } catch (err) {
      fromServer(err);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const p = injectedProvider();
    if (!p || !quote || !account) return;
    setBusy('send');
    setProblem(null);
    setError(null);
    try {
      /*
       * The calldata comes from the server, built from the stored quote. The
       * wallet is handed something it can check rather than fields a page
       * assembled: the token, the receiver and the amount are all inside it,
       * and all three decide where money goes.
       */
      const prepared = await apiFetch<PreparedTransfer>(`/v1/orders/${quote.orderId}/stablecoin-prepare`, {
        method: 'POST',
      });
      const hash = (await p.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: prepared.to, data: prepared.data, value: '0x0' }],
      })) as string;
      setTxHash(hash);
      await report(quote.orderId, hash);
    } catch (err) {
      if (err instanceof ApiError) fromServer(err);
      else fromWallet(err);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Tells the server where to look. A hint, never an instruction: attribution
   * comes from the open intent of the transaction's own sender, so a hash from
   * somewhere else resolves to that sender's order or to nothing.
   */
  const report = async (orderId: string, hash: string) => {
    try {
      await apiFetch(`/v1/orders/${orderId}/stablecoin-transaction`, {
        method: 'POST',
        body: { txHash: hash },
      });
    } catch (err) {
      // Not fatal, and deliberately not surfaced as a failure: the scanner
      // finds the same payment on its next pass regardless of this call.
      if (!(err instanceof ApiError)) return;
    }
  };

  const reportTyped = async () => {
    if (!quote) return;
    const hash = typedHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      setProblem('unknown');
      return;
    }
    setBusy('manual');
    setProblem(null);
    try {
      setTxHash(hash);
      await report(quote.orderId, hash);
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------ the polling */

  const orderId = quote?.orderId ?? null;
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const delivered = !!status?.entitlementGranted;
  const deliveredRef = useRef(false);
  deliveredRef.current = delivered;

  useEffect(() => {
    if (!orderId || !txHash || delivered) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    setGaveUp(false);

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await apiFetch<PaymentStatusResponse>(`/v1/orders/${orderId}/payment-status`);
        if (cancelled) return;
        setStatus(res);
        if (res.entitlementGranted) {
          // The credits are in the account; the header should say so.
          await refreshEntitlements();
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err);
      }
      attempt += 1;
      if (attempt >= 30) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(() => void tick(), pollDelayMs(attempt));
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, txHash, delivered, round, refreshEntitlements]);

  /* ------------------------------------------------------------ the render */

  if (!runtime) return <Loading />;
  if (!stablecoin?.enabled || tokens.length === 0) {
    return (
      <div className="stack" style={{ maxWidth: 620, margin: '0 auto' }}>
        <h1 style={{ fontSize: 26 }}>{t('scpay.title')}</h1>
        <p className="muted">{t('scpay.unavailable')}</p>
        <Link className="btn" to="/pricing">
          {t('pay.backToPricing')}
        </Link>
      </div>
    );
  }

  const amount = quote ? formatAtomic(quote.amountAtomic, quote.tokenDecimals) : null;
  const explorer = quote && txHash ? explorerTxUrl(quote.chainId, txHash) : null;

  return (
    <div className="stack stack--loose" style={{ maxWidth: 620, margin: '0 auto' }}>
      <h1 style={{ fontSize: 26 }}>{t('scpay.title')}</h1>

      {problem && (
        <div className="alert alert--warn" role="alert" aria-live="assertive">
          {t(`scpay.err.${problem}`)}
        </div>
      )}
      <ErrorNotice error={error} />

      {step === 'install' && (
        <section className="panel stack">
          <h2 style={{ fontSize: 20, margin: 0 }}>{t('scpay.install.title')}</h2>
          <p className="muted">{t('scpay.install.body')}</p>
          <Link className="btn btn--primary" to={`/checkout/confirm?price=${priceKey}`}>
            {t('scpay.install.useCard')}
          </Link>
        </section>
      )}

      {step !== 'install' && (
        <section className="panel stack">
          <div className="row row--between">
            <h2 style={{ fontSize: 20, margin: 0 }}>{t('scpay.wallet.title')}</h2>
            {account && (
              <span className="small" style={{ fontFamily: 'var(--mono)' }}>
                {shorten(account)}
              </span>
            )}
          </div>

          {step === 'connect' && (
            <>
              <p className="muted">{t('scpay.connect.note')}</p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={() => void connect()}
              >
                {busy === 'connect' ? t('scpay.working') : t('scpay.connect.cta')}
              </button>
            </>
          )}

          {step === 'switch-chain' && (
            <>
              <p className="muted">{t('scpay.switch.note', { chain: String(wantChainId) })}</p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={() => void switchChain()}
              >
                {busy === 'switch' ? t('scpay.working') : t('scpay.switch.cta')}
              </button>
            </>
          )}

          {step === 'prove' && (
            <>
              <p className="muted">{t('scpay.prove.note')}</p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={() => void prove()}
              >
                {busy === 'prove' ? t('scpay.working') : t('scpay.prove.cta')}
              </button>
            </>
          )}

          {step === 'quote' && (
            <>
              <p className="muted">{t('scpay.quote.note')}</p>
              {tokens.length > 1 && (
                <div className="row">
                  {tokens.map((tok) => (
                    <button
                      key={tok.key}
                      type="button"
                      className={tokenKey === tok.key ? 'btn btn--primary' : 'btn'}
                      onClick={() => setTokenKey(tok.key)}
                    >
                      {tok.key.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={() => void takeQuote()}
              >
                {busy === 'quote' ? t('scpay.working') : t('scpay.quote.cta')}
              </button>
            </>
          )}
        </section>
      )}

      {quote && (
        <section className="panel stack">
          <h2 style={{ fontSize: 20, margin: 0 }}>{t('scpay.amount.title')}</h2>
          <div className="table-wrap">
            <table style={{ minWidth: 0 }}>
              <tbody>
                <tr>
                  <th>{t('scpay.amount.label')}</th>
                  <td className="num">
                    {t('scpay.amount.value', { amount: amount ?? '', token: quote.tokenKey.toUpperCase() })}
                  </td>
                </tr>
                <tr>
                  <th>{t('scpay.price.label')}</th>
                  <td className="num">{formatMoney(quote.priceJpy, 'jpy', LOCALES[lang])}</td>
                </tr>
                <tr>
                  <th>{t('scpay.receiver.label')}</th>
                  <td className="small" style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                    {quote.receiver}
                  </td>
                </tr>
                <tr>
                  <th>{t('scpay.expires.label')}</th>
                  <td className="num">{expired ? t('scpay.expired') : countdown(left)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {quote.roundedUp && <p className="small muted">{t('scpay.roundedUp')}</p>}

          {expired ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null}
              onClick={() => void takeQuote()}
            >
              {t('scpay.requote')}
            </button>
          ) : (
            step === 'send' && (
              <>
                <button
                  type="button"
                  className="btn btn--primary btn--block"
                  disabled={busy !== null}
                  onClick={() => void send()}
                >
                  {busy === 'send' ? t('scpay.working') : t('scpay.send.cta')}
                </button>
                <p className="small muted">{t('scpay.send.note')}</p>

                <details>
                  <summary>{t('scpay.manual.title')}</summary>
                  <div className="stack" style={{ marginTop: 'var(--s2)' }}>
                    <p className="small muted">{t('scpay.manual.note')}</p>
                    <input
                      type="text"
                      style={{ fontFamily: 'var(--mono)' }}
                      value={typedHash}
                      onChange={(e) => setTypedHash(e.target.value)}
                      placeholder={t('scpay.manual.placeholder')}
                      aria-label={t('scpay.manual.placeholder')}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null}
                      onClick={() => void reportTyped()}
                    >
                      {busy === 'manual' ? t('scpay.working') : t('scpay.manual.cta')}
                    </button>
                  </div>
                </details>
              </>
            )
          )}
        </section>
      )}

      {step === 'waiting' && (
        <section className="panel stack">
          <h2 style={{ fontSize: 20, margin: 0 }}>{t('scpay.waiting.title')}</h2>
          <p className="muted">{t('scpay.waiting.body')}</p>
          {status?.intent?.state === 'review' && (
            <div className="alert alert--warn" role="alert">
              {t('scpay.waiting.review')}
            </div>
          )}
          {explorer && (
            <a className="small" href={explorer} target="_blank" rel="noreferrer noopener">
              {t('scpay.tx.link')}
            </a>
          )}
          {gaveUp && (
            <>
              <p className="small muted">{t('scpay.waiting.slow')}</p>
              <button type="button" className="btn" onClick={() => setRound((r) => r + 1)}>
                {t('scpay.waiting.checkAgain')}
              </button>
            </>
          )}
        </section>
      )}

      {step === 'done' && (
        <section className="panel stack">
          <h2 style={{ fontSize: 20, margin: 0 }}>{t('scpay.done.title')}</h2>
          <p className="muted">{t('scpay.done.body')}</p>
          {explorer && (
            <a className="small" href={explorer} target="_blank" rel="noreferrer noopener">
              {t('scpay.tx.link')}
            </a>
          )}
          <Link className="btn btn--primary" to="/library">
            {t('scpay.done.toLibrary')}
          </Link>
        </section>
      )}
    </div>
  );
}

/** `0x1234…cdef`: enough to recognise, not enough to mistype from. */
function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
