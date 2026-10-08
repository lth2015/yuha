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
 * `支払方法` is deliberately in the second group: the Stripe session is created
 * without `payment_method_types`, so the methods offered are whatever that
 * account has enabled. It is not knowable from this repository.
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
          <dt>所在地</dt>
          <dd>{d.address}</dd>
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
            <Pending what="決済代行（Stripe）アカウントで有効化されている決済手段に依存するため、コードからは確定できません" />
          </dd>
        </div>
        <div>
          <dt>支払時期</dt>
          <dd>お申し込み時に決済代行の画面でお支払いいただきます。</dd>
        </div>
        <div>
          <dt>役務の提供時期</dt>
          <dd>お支払いの確認後ただちに、生成回数がアカウントに反映されます。</dd>
        </div>
        <div>
          <dt>返品・キャンセル</dt>
          <dd>
            <Pending what="解約・返金条件の文言。現行の記載は docs 側の草案であり、確認が必要です" />
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
