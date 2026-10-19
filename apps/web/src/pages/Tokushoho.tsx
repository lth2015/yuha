/*
 * i18n-exempt-file: 特定商取引法に基づく表記 is a Japanese statutory disclosure
 * addressed to consumers under Japanese law. Its operative text stays in
 * Japanese rather than following the reader's chosen language, and it is not
 * translation debt. This marker is read by scripts/check-i18n.mjs.
 */
import { useEffect, useState } from 'react';
import type { ProductView } from '@yuha/contracts';
import { fetchProducts } from '../lib/catalog';
import { LOCALES, formatMoney } from '../lib/money';
import { unconfiguredDisclosureField } from '../lib/disclosure';
import { textIn } from '../lib/i18n';
import { cardPaymentsEnabled } from '../lib/purchase';
import { useSession } from '../lib/session';
import { DraftBanner, LegalPage, useDisclosure } from './Legal';
import { Loading } from '../components/common';

/**
 * 特定商取引法に基づく表記.
 *
 * This route used to render the general company page. That page carries the
 * operator block and a refunds section, and the statute also requires the
 * price, any charges beyond it, the payment method, when payment is taken and
 * when the thing bought is delivered. Those were only on the 最終確認画面,
 * which a buyer reaches after deciding — the 表記 has to be readable before.
 *
 * Two different kinds of row live here and they are marked differently:
 *
 *   - Facts the running system already determines — the catalogue's prices,
 *     when credits are granted — are read from it at render time, so this page
 *     cannot drift away from what is actually charged and delivered.
 *   - Anything that is a legal statement, or that depends on configuration
 *     nobody has set yet, is left for counsel and says so on the page rather
 *     than carrying a plausible guess.
 *
 * `支払方法` moved to the first group once counsel had reviewed the page
 * (2026-10-19): the channels are read from the runtime descriptor — card when
 * a card purchase can complete here, Alipay / WeChat Pay when the operator
 * declares them enabled on the Stripe account (`qrWalletsEnabled`; the Stripe
 * session is created without `payment_method_types`, so the account decides),
 * and the stablecoins the deployment accepts. `返品・キャンセル` reads the
 * confirmation screen's own Japanese entries, so the two statutory surfaces
 * say the same thing by construction.
 */

/** A row whose value is still owed by someone qualified. */
function Pending({ what }: { what: string }) {
  return (
    <span className="tokushoho__pending">
      <strong>要法務確認</strong> — {what}
    </span>
  );
}

/*
 * Only products that can actually be bought.
 *
 * This mapped every entry from /v1/products with no filter, and
 * `listProducts` marks subscriptions `available: false` while
 * FEATURE_SUBSCRIPTIONS_ENABLED is off — which /pricing renders as "coming
 * soon". So with subscriptions closed, the 特定商取引法 page advertised
 * CREATOR and STUDIO as 販売価格 with 自動更新, as a statutory disclosure of
 * prices, for two plans the product refuses to sell.
 */
function priceLines(products: ProductView[]): string[] {
  const locale = LOCALES.ja;
  return products.filter((p) => p.available).map((p) => {
    const amount = formatMoney(p.amountMinor, p.currency, locale);
    const unit = p.kind === 'subscription' ? '／月（自動更新）' : '（買い切り）';
    const validity = p.validityDays ? `・有効期限 ${p.validityDays} 日` : '';
    return `${p.displayName}：${amount}${unit}${validity}`;
  });
}

export function Tokushoho() {
  const d = useDisclosure();
  const { runtime } = useSession();
  const card = cardPaymentsEnabled(runtime);
  const stablecoins = runtime?.stablecoin.enabled ? runtime.stablecoin.tokens.map((x) => x.label) : [];
  const [products, setProducts] = useState<ProductView[] | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);

  useEffect(() => {
    fetchProducts()
      .then(setProducts)
      .catch(() => setCatalogueFailed(true));
  }, []);

  if (!d) return <Loading />;

  return (
    <LegalPage title="特定商取引法に基づく表記">
      <DraftBanner isPlaceholder={d.isPlaceholder} />

      <p className="small muted">
        本ページは法定表示事項の記載欄です。<strong>要法務確認</strong>と記載された項目は、
        公開前に有資格者の確認が必要です。
      </p>

      <dl className="company-facts tokushoho">
        <div>
          <dt>販売業者</dt>
          <dd>{d.entityName}</dd>
        </div>
        <div>
          <dt>運営統括責任者</dt>
          <dd>
            {unconfiguredDisclosureField(d.representative) ? (
              <Pending what="法定必須項目。未設定です（LEGAL_ENTITY_REPRESENTATIVE）" />
            ) : (
              d.representative
            )}
          </dd>
        </div>
        <div>
          {/* Withheld from the page and provided on request (counsel,
              2026-10-19); the API does not serve it at all. */}
          <dt>所在地</dt>
          <dd>ご請求があった場合には、下記メールアドレス宛てにご連絡いただければ遅滞なく開示いたします。</dd>
        </div>
        <div>
          <dt>電話番号</dt>
          <dd>{unconfiguredDisclosureField(d.phone) ? <Pending what="法定必須項目。未設定です（LEGAL_ENTITY_PHONE）" /> : d.phone}</dd>
        </div>
        <div>
          <dt>メールアドレス</dt>
          <dd>{d.contact}</dd>
        </div>

        <div>
          <dt>販売価格</dt>
          <dd>
            {catalogueFailed ? (
              <Pending what="商品目録を読み込めませんでした" />
            ) : !products ? (
              '読み込み中…'
            ) : (
              <ul className="tokushoho__prices">
                {priceLines(products).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <span className="small muted">表示価格はすべて消費税込みです。</span>
          </dd>
        </div>
        <div>
          <dt>商品代金以外に必要な料金</dt>
          <dd>
            当社が請求する追加料金はありません。インターネット接続に要する通信料は
            お客様のご負担となります。
          </dd>
        </div>
        <div>
          <dt>支払方法</dt>
          <dd>
            <ul className="tokushoho__prices">
              {card && <li>クレジットカード（決済代行：Stripe）</li>}
              {card && runtime?.features.qrWalletsEnabled && <li>Alipay・WeChat Pay（単発購入のみ）</li>}
              {stablecoins.length > 0 && (
                <li>ステーブルコイン：{stablecoins.join('、')}（単発パック・ライセンスのみ）</li>
              )}
              {!card && stablecoins.length === 0 && <li>現在ご利用いただける決済手段はありません。</li>}
            </ul>
          </dd>
        </div>
        <div>
          <dt>支払時期</dt>
          <dd>
            {card && 'お申し込み時に決済代行の画面でお支払いいただきます。'}
            {stablecoins.length > 0 && 'ステーブルコインの場合は、お申し込み時にお客様ご自身のウォレットから送金していただきます。'}
          </dd>
        </div>
        <div>
          <dt>役務の提供時期</dt>
          <dd>お支払いの確認後ただちに、生成回数がアカウントに反映されます。</dd>
        </div>
        <div>
          <dt>返品・キャンセル</dt>
          <dd>
            <ul className="tokushoho__prices">
              <li>単発パック・ライセンス：{textIn('ja', 'checkout.cancel.oneTime')}</li>
              <li>月額プラン：{textIn('ja', 'checkout.cancel.sub')}</li>
              <li>返金：{textIn('ja', 'checkout.refund')}</li>
            </ul>
          </dd>
        </div>
        <div>
          <dt>動作環境</dt>
          <dd>
            最新版の Google Chrome、Safari、Microsoft Edge または Firefox。
            音声の再生とダウンロードが可能な環境が必要です。
          </dd>
        </div>
      </dl>
    </LegalPage>
  );
}
