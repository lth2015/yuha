import { ERROR_CODES, type ErrorCode } from '@yuha/contracts';
import { ApiError, NetworkError } from './api';

/**
 * Japanese copy for every error code, each with a concrete next step (UI-12).
 *
 * The record is typed over the full ErrorCode union, so adding a code to the
 * contracts package without adding Japanese text here is a compile error rather
 * than a silent "エラーが発生しました" in front of a user.
 */
export interface UserMessage {
  title: string;
  /** What to do now. UI-12 requires every failure state to have a next step. */
  next: string;
  tone: 'error' | 'warn' | 'info';
}

export const ERROR_MESSAGES: Record<ErrorCode, UserMessage> = {
  MFA_INVALID_CODE: {
    title: 'That code did not match',
    next: 'Codes rotate every 30 seconds — enter the current one from your authenticator, or use a recovery code.',
    tone: 'error',
  },
  MFA_NOT_ENROLLED: {
    title: 'Two-factor is not set up on this account',
    next: 'Enable it from Account settings first.',
    tone: 'info',
  },
  AUTH_EXCHANGE_FAILED: {
    title: 'Sign-in could not be completed',
    next: 'The one-time code may have expired. Start sign-in again from the beginning.',
    tone: 'error',
  },
  UNAUTHENTICATED: {
    title: 'ログインが必要です',
    next: 'もう一度ログインしてください。作成中の内容は保存されています。',
    tone: 'info',
  },
  FORBIDDEN: {
    title: 'この操作は許可されていません',
    next: 'アカウントを確認してください。心当たりがない場合はサポートへご連絡ください。',
    tone: 'error',
  },
  AGE_NOT_CONFIRMED: {
    title: '18歳以上の確認が必要です',
    next: '本サービスの生成と購入は18歳以上の方が対象です。設定から確認してください。',
    tone: 'warn',
  },
  TERMS_NOT_ACCEPTED: {
    title: '利用規約への同意が必要です',
    next: '利用規約とプライバシーポリシーをご確認のうえ、同意してください。',
    tone: 'warn',
  },
  VALIDATION_FAILED: {
    title: '入力内容を確認してください',
    next: '赤く表示されている項目を修正して、もう一度お試しください。',
    tone: 'warn',
  },
  PROMPT_TOO_LONG: {
    title: '文字数が上限を超えています',
    next: '300文字以内に収めてください。気分・楽器・テンポに絞ると伝わりやすくなります。',
    tone: 'warn',
  },
  PROMPT_BLOCKED: {
    title: 'この内容では作成できません',
    next: '気分・楽器・テンポの言葉で書き直してください。判定に問題がある場合は報告できます。',
    tone: 'warn',
  },
  UNSUPPORTED_CAPABILITY: {
    title: '現在この設定には対応していません',
    next: '対応している設定に変更してください。今後の対応可否はお知らせページでご案内します。',
    tone: 'warn',
  },
  NOT_FOUND: {
    title: '見つかりませんでした',
    next: '削除された可能性があります。作品一覧から選び直してください。',
    tone: 'warn',
  },
  IDEMPOTENCY_KEY_REUSED: {
    title: '前回と内容が異なります',
    next: 'ページを再読み込みして、あらためて作成してください。二重に消費されることはありません。',
    tone: 'warn',
  },
  CONFLICT: {
    title: '状態が変わりました',
    next: '最新の状態を読み込みます。少し待ってからもう一度お試しください。',
    tone: 'warn',
  },
  RATE_LIMITED: {
    title: 'リクエストが多すぎます',
    next: '少し時間をおいてからお試しください。同時に実行できる生成数には上限があります。',
    tone: 'warn',
  },
  INSUFFICIENT_CREDITS: {
    title: '残り回数が足りません',
    next: '料金ページから回数を追加してください。入力中の内容は保存されています。',
    tone: 'warn',
  },
  ENTITLEMENT_EXPIRED: {
    title: '回数の有効期限が切れています',
    next: '有効な回数を追加してください。期限内に開始した生成は引き続き処理されます。',
    tone: 'warn',
  },
  JOB_NOT_CANCELLABLE: {
    title: 'この生成は取り消せません',
    next: 'すでに処理が進んでいます。完了までお待ちください。',
    tone: 'info',
  },
  UPSTREAM_UNAVAILABLE: {
    title: '音楽生成サービスが混み合っています',
    next: '回数は消費されていません。時間をおいてもう一度お試しください。',
    tone: 'warn',
  },
  UPSTREAM_REJECTED: {
    title: '生成が受け付けられませんでした',
    next: '回数は消費されていません。表現を変えてお試しください。',
    tone: 'warn',
  },
  UPSTREAM_TIMEOUT: {
    title: '確認中です',
    next: '結果を確認しています。二重に請求されることはありません。完了までお待ちください。',
    tone: 'info',
  },
  OUTPUT_CHECK_FAILED: {
    title: '品質チェックを通過しませんでした',
    next: '回数は消費されていません。もう一度お試しください。',
    tone: 'warn',
  },
  GENERATION_FAILED: {
    title: '生成に失敗しました',
    next: '回数は消費されていません。時間をおいてお試しください。',
    tone: 'error',
  },
  TRACK_NOT_DELIVERABLE: {
    title: 'この楽曲はまだ利用できません',
    next: '処理の完了をお待ちください。作品一覧で状態を確認できます。',
    tone: 'info',
  },
  TRACK_SUSPENDED: {
    title: 'この楽曲は一時停止中です',
    next: '権利申立の確認中です。停止は侵害の認定を意味しません。結果はメールでお知らせします。',
    tone: 'warn',
  },
  CHECKOUT_UNAVAILABLE: {
    title: '購入手続きを開始できません',
    next: '時間をおいてお試しください。料金は発生していません。',
    tone: 'error',
  },
  PAYMENT_NOT_CONFIRMED: {
    title: 'お支払いを確認中です',
    next: '確認できしだい回数が反映されます。この画面を閉じても処理は続きます。',
    tone: 'info',
  },
  SUBSCRIPTION_NOT_FOUND: {
    title: '対象のサブスクリプションが見つかりません',
    next: '請求ページで契約状況をご確認ください。',
    tone: 'warn',
  },
  SUBSCRIPTIONS_DISABLED: {
    title: '月額プランは現在受付していません',
    next: '単発パックをご利用ください。開始時期はお知らせページでご案内します。',
    tone: 'info',
  },
  WEBHOOK_SIGNATURE_INVALID: {
    title: '検証に失敗しました',
    next: 'この操作は反映されていません。サポートへご連絡ください。',
    tone: 'error',
  },
  BUDGET_EXCEEDED: {
    title: '本日の生成上限に達しました',
    next: '既存の作品のダウンロードと注文の確認は引き続きご利用いただけます。',
    tone: 'warn',
  },
  SERVICE_DISABLED: {
    title: '現在この機能を停止しています',
    next: '復旧までお待ちください。既存の作品のダウンロードはご利用いただけます。',
    tone: 'warn',
  },
  INTERNAL_ERROR: {
    title: '問題が発生しました',
    next: '時間をおいてお試しください。回数が消費された場合は自動的に返却されます。',
    tone: 'error',
  },
};

const NETWORK_MESSAGE: UserMessage = {
  title: '通信できませんでした',
  next: '電波の状態を確認して、もう一度お試しください。入力内容は保存されています。',
  tone: 'error',
};

const UNKNOWN_MESSAGE: UserMessage = {
  title: '予期しないエラーが発生しました',
  next: '時間をおいてお試しください。繰り返す場合はサポートへご連絡ください。',
  tone: 'error',
};

export function messageFor(err: unknown): UserMessage {
  if (err instanceof NetworkError) return NETWORK_MESSAGE;
  if (err instanceof ApiError) return ERROR_MESSAGES[err.code] ?? UNKNOWN_MESSAGE;
  return UNKNOWN_MESSAGE;
}

/** Extra guidance for a blocked prompt, keyed by the server's hint (SEC-07). */
export const PROMPT_HINTS: Record<string, string> = {
  'prompt.tooLong': 'Keep the description within the length limit.',
  'prompt.noExistingLyrics': 'Write your own lyrics — quoting lyrics of an existing song is not supported.',
  'prompt.noUrl': 'URLは受け付けていません。参考曲の指定はできません。気分や楽器で表現してください。',
  'prompt.noPersonalInfo': 'メールアドレスやカード番号などの個人情報は入力しないでください。',
  'prompt.rewriteAsMood': '曲の雰囲気を、気分・楽器・テンポの言葉で書いてください。',
  'prompt.noVoiceImitation': '実在する人物の声や歌い方の再現には対応していません。',
  'prompt.noArtistOrTitle': 'アーティスト名や曲名の指定はできません。雰囲気の言葉に置き換えてください。',
};

/** Compile-time completeness guard for the message table. */
const _exhaustive: readonly ErrorCode[] = ERROR_CODES;
void _exhaustive;

export const JOB_PHASE_LABELS: Record<string, { label: string; detail: string }> = {
  validating: { label: '確認中', detail: '入力内容と残り回数を確認しています' },
  queued: { label: '順番待ち', detail: '生成の順番を待っています' },
  generating: { label: '生成中', detail: '音源を作っています' },
  processing: { label: '仕上げ中', detail: '音量調整と品質チェックをしています' },
  verifying: { label: '確認中', detail: '結果を確認しています。二重請求は発生しません' },
  done: { label: '完了', detail: '再生とダウンロードができます' },
  failed: { label: '未完了', detail: '回数は消費されていません' },
};

export const SCENE_LABELS: Record<string, { title: string; description: string }> = {
  night_walk: { title: '夜の散歩', description: '夜景・帰り道・静かな時間' },
  daily_log: { title: '日常記録', description: 'Vlog・料理・部屋・何気ない一日' },
  outfit: { title: 'コーデ', description: '着替え・お出かけ前・ファッション' },
  gaming: { title: 'ゲーム', description: 'プレイ切り抜き・ハイライト' },
};

export const MOOD_LABELS: Record<string, string> = {
  calm: '静けさ',
  dreamy: '夢見心地',
  warm: 'あたたかさ',
  melancholic: '切なさ',
  confident: '自信',
  playful: '軽やか',
  tense: '緊張感',
  uplifting: '前向き',
};

export const TRACK_STATE_LABELS: Record<string, { label: string; tone: string }> = {
  processing: { label: '処理中', tone: 'badge--warn' },
  deliverable: { label: 'ダウンロード可', tone: 'badge--ok' },
  suspended: { label: '確認中', tone: 'badge--warn' },
  deleted: { label: '削除済み', tone: '' },
};
