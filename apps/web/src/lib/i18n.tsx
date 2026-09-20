import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Trilingual UI (acceptance §6): zh-CN is the development baseline, ja for
 * the Japan launch, en for international. One slogan per language, from the
 * brand doc — zh 让心动，有回声。/ ja ときめきに、響きを。/ en Let a feeling echo.
 * Missing keys fall back to Chinese rather than leaking raw ids.
 */
export type Lang = 'zh' | 'ja' | 'en';

const LANG_KEY = 'yuha.lang';
export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'zh', label: '中' },
  { code: 'ja', label: '日' },
  { code: 'en', label: 'EN' },
];

type Dict = Record<string, string>;

const zh: Dict = {
  'nav.create': '创作',
  'nav.library': '我的作品',
  'nav.market': '市场',
  'nav.signin': '登录',
  'nav.start': '开始创作',
  'nav.credits': '可用 {n} 次',
  'nav.skip': '跳到内容',
  'account.mySongs': '我的作品',
  'account.billing': '账单',
  'account.settings': '账户设置',
  'account.console': '控制台',
  'account.signOut': '退出登录',

  'hero.eyebrow': 'A LITTLE FEELING. YOUR OWN SOUND.',
  'hero.slogan1': '让心动，',
  'hero.slogan2': '有回声。',
  'hero.intro': '写下一段心情，做成属于这一刻的音乐。',
  'composer.label': '今天，想听见什么？',
  'composer.placeholder': '傍晚的海边，朋友骑车回家。轻快一点，像风穿过衬衫。',
  'composer.format': '30 秒 · 纯音乐 · 仅自己可见',
  'composer.cost': '每次生成消耗 1 次额度',
  'composer.credits': '当前可用 {n} 次',
  'composer.creditsLogin': '登录后可查看可用次数',
  'composer.submit': '生成音乐 · 1 次',
  'composer.submitting': '正在提交…',
  'composer.feedback': '从一句话开始，也可以选一种心情。',
  'composer.moodKept': '已保留你的文字；可以手动补充「{mood}」的感觉。',
  'composer.moodSeeded': '已经放入一个起点，你可以随意修改。',
  'mood.city': '城市散步',
  'mood.sunset': '日落公路',
  'mood.rain': '房间里的雨',
  'mood.night': '深夜自习',
  'mood.city.text': '城市散步，节奏轻快。干净的鼓点和柔软的合成器，像周末没安排的下午。',
  'mood.sunset.text': '日落公路，朋友骑车回家。轻快一点，像风穿过衬衫。',
  'mood.rain.text': '房间里的雨，温暖的钢琴和轻柔的环境声。安静，但有一点期待。',
  'mood.night.text': '深夜自习，安静的白噪音和微弱的心跳感，专注而平静。',
  'art.index1': 'YUHA / 001',
  'art.index2': 'FEEL SOMETHING.',
  'art.h2a': '一片花瓣。', 'art.h2b': '一点风。',
  'art.pa': '把没有说出口的，', 'art.pb': '交给下一段旋律。',
  'home.echoes': '此刻的回声',
  'home.toMarket': '逛逛市场 →',

  'wait.heading': '你的音乐，正在路上。',
  'wait.sub': '可以离开这个页面，稍后在「我的作品」查看。',
  'wait.s1': '正在确认这次创作', 'wait.s2': '已加入队列', 'wait.s3': '正在生成你的音乐', 'wait.s4': '已完成，可以试听',
  'wait.done': '已完成', 'wait.doing': '进行中', 'wait.todo': '待完成',
  'wait.failed': '这次没有完成，额度已按服务端确认退回。你可以修改描述后重试。',
  'wait.goLibrary': '去我的作品',

  'song.play': '试听', 'song.pause': '暂停',
  'song.private': '私人收藏', 'song.public': '市场在架', 'song.work': '作品',
  'song.instrumental': '纯音乐', 'song.vocals': '有人声',
  'song.you': '你', 'song.creator': '一位创作者', 'song.plays': '{n} 次播放',
  'song.like': '♡ {n}', 'song.share': '分享 ↗', 'song.copied': '已复制链接',
  'song.edit': 'AI 再创作 ↗', 'song.download': '下载 MP3 ↓', 'song.downloadLicensed': '下载已授权 MP3 ↓',
  'song.publish': '发布到市场 ↗', 'song.unpublish': '取消发布',
  'song.delete': '删除', 'song.confirmDelete': '删除「{title}」？此操作不可撤销。',
  'song.license': '购买授权 · ${price} ↗', 'song.licensing': '正在打开支付…',
  'song.licensesSold': '已在市场售出 {n} 份授权',
  'song.demo': '演示环境：音频为合成示例。',
  'song.lyrics': '歌词', 'song.usage': '使用条件',
  'song.usageBody': '每首作品都记录着生成当时适用的使用条件。',
  'song.usageFull': '查看完整记录',
  'song.backMarket': '回到市场',
  'song.notFound': '页面不存在',
  'cover.aria': '「{title}」的封面',
  'lyrics.instrumental': '纯音乐——没有歌词可以显示。',
  'lyrics.estimated': '估算同步', 'lyrics.aligned': '词级同步',
  'lyrics.playFrom': '从这里播放',

  'card.play': '播放「{title}」', 'card.pause': '暂停「{title}」',
  'card.like': '喜欢「{title}」', 'card.unlike': '取消喜欢「{title}」',
  'card.more': '「{title}」的更多操作',
  'card.open': '打开', 'card.download': '下载 MP3',
  'card.publish': '发布到市场', 'card.unpublish': '取消发布', 'card.delete': '删除',
  'card.onMarket': '市场在架', 'card.generating': '生成中…',
  'card.you': '你', 'card.creator': '创作者',

  'player.play': '播放', 'player.pause': '暂停', 'player.prev': '上一首', 'player.next': '下一首',
  'player.buffering': '缓冲中…', 'player.error': '播放失败', 'player.queue': '播放队列',
  'player.expand': '打开正在播放', 'player.nowPlaying': '正在播放', 'player.paused': '已暂停',
  'player.close': '关闭',

  'market.eyebrow': 'YUHA 市场',
  'market.title': '大家做出来的榜单',
  'market.sub': '这里的每一首作品都由 YUHA 创作者生成并发布到市场。可以试听、喜欢，也可以带着灵感去做你自己的版本。',
  'market.trending': '热度', 'market.new': '最新',
  'market.all': '全部', 'market.instrumental': '纯音乐', 'market.vocals': '有人声',
  'market.search': '搜索作品或风格…', 'market.searchBtn': '搜索',
  'market.top10': '前十', 'market.rankBy': '按播放与喜欢排序',
  'market.fresh': '新上架', 'market.empty': '暂时没有匹配的作品。换个筛选试试——或者去做那首属于这里的歌。',
  'market.loadMore': '加载更多', 'market.loading': '加载中…',
  'market.stats': '{plays} 次播放 · {likes} 个喜欢',

  'lib.title': '我的作品', 'lib.new': '新的创作',
  'lib.all': '全部', 'lib.finished': '已完成', 'lib.generating': '生成中', 'lib.paused': '已暂停',
  'lib.search': '搜索你的作品…',
  'lib.empty': '还没有作品', 'lib.emptySub': '生成过的音乐会出现在这里——默认私密，发布前只有你能看到。',
  'lib.create': '开始第一段创作',
  'lib.loadMore': '加载更多', 'lib.loading': '加载中…',
  'earn.title': '市场收益', 'earn.share': '每笔授权你获得 {n}%',
  'earn.total': '累计收益 · {n} 笔', 'earn.pending': '待结算', 'earn.cleared': '已结算', 'earn.paid': '已支付',
  'earn.perTrack': '{n} 份授权 · {amount}',

  'auth.welcome': '来到 YUHA',
  'auth.sub': '写下心情，做成音乐。用 Google 账号继续。',
  'auth.google': '使用 Google 继续',
  'auth.googleNotConfigured': 'Google 登录尚未配置',
  'auth.googleHint': '在 API 环境变量中设置 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET 和 GOOGLE_REDIRECT_URI 后，按钮会自动出现。',
  'auth.or': '或使用开发身份登录',
  'auth.email': '邮箱',
  'auth.age': '我已年满 18 岁',
  'auth.terms': '我同意《服务条款》与《隐私政策》',
  'auth.marketing': '接收产品动态（可选）',
  'auth.continue': '继续',
  'auth.dev': '开发身份',

  'mfa.title': '两步验证',
  'mfa.sub': '输入 Google 身份验证器中的 6 位验证码（或一个恢复码），完成登录。',
  'mfa.code': '验证码',
  'mfa.lost': '手机丢了？可以输入任意一个恢复码。',
  'mfa.verify': '验证并登录', 'mfa.verifying': '正在验证…',
  'mfa.restart': '重新开始',

  'footer.terms': '服务条款', 'footer.privacy': '隐私', 'footer.company': '公司信息',
  'footer.rights': '内容申诉', 'footer.slogan': '让心动，有回声。',
  'footer.made': '© {year} NetStars Co., Ltd.',
};

const ja: Dict = {
  'nav.create': '創作', 'nav.library': 'マイ作品', 'nav.market': 'マーケット',
  'nav.signin': 'ログイン', 'nav.start': '創作をはじめる',
  'nav.credits': '残り {n} 回', 'nav.skip': '本文へスキップ',
  'account.mySongs': 'マイ作品', 'account.billing': '請求', 'account.settings': 'アカウント設定',
  'account.console': 'コンソール', 'account.signOut': 'ログアウト',

  'hero.eyebrow': 'A LITTLE FEELING. YOUR OWN SOUND.',
  'hero.slogan1': 'ときめきに、', 'hero.slogan2': '響きを。',
  'hero.intro': '気持ちを書いて、この瞬間だけの音楽に。',
  'composer.label': '今日は、どんな音を聴きたい？',
  'composer.placeholder': '夕方の海辺、友達と自転車で帰る道。軽やかに、風を通すように。',
  'composer.format': '30 秒 · インスト · 自分のみ閲覧可',
  'composer.cost': '1 回の生成で 1 クレジット消費',
  'composer.credits': '現在 {n} 回利用可能', 'composer.creditsLogin': 'ログインすると残数が表示されます',
  'composer.submit': '音楽をつくる · 1 回', 'composer.submitting': '送信中…',
  'composer.feedback': '一文から始めても、気分から選んでも。',
  'composer.moodKept': '入力中の文章はそのまま。「{mood}」の感触を手で足せます。',
  'composer.moodSeeded': 'たたき台を入れました。自由に書き換えてください。',
  'mood.city': '街の散歩', 'mood.sunset': '夕日の公路', 'mood.rain': '部屋の雨', 'mood.night': '深夜の自習',
  'mood.city.text': '街を歩くような軽いタempo。クリーンなドラムと柔らかいシンセ、予定のない週末の午後。',
  'mood.sunset.text': '夕日の公路、友達と自転車で帰る道。軽やかに、シャツを通る風のように。',
  'mood.rain.text': '部屋に降る雨、温かいピアノとやさしい環境音。静かだけど、少しの期待。',
  'mood.night.text': '深夜の自習、静かなホワイトノイズとかすかな鼓動。集中と静けさ。',
  'art.h2a': 'ひとひらの花びら。', 'art.h2b': 'すこしの風。',
  'art.pa': '言えなかったことを、', 'art.pb': '次のメロディにゆだねる。',
  'home.echoes': 'いまのこだま', 'home.toMarket': 'マーケットへ →',

  'wait.heading': '音楽は、いま向かっています。',
  'wait.sub': 'ページを離れても大丈夫。あとで「マイ作品」で確認できます。',
  'wait.s1': '創作を確認中', 'wait.s2': 'キューに追加されました', 'wait.s3': '音楽を生成中', 'wait.s4': '完成、試聴できます',
  'wait.done': '完了', 'wait.doing': '進行中', 'wait.todo': '待機',
  'wait.failed': '今回は完成しませんでした。クレジットは返却されています。書き直して再試行できます。',
  'wait.goLibrary': 'マイ作品へ',

  'song.play': '試聴', 'song.pause': '一時停止',
  'song.private': '非公開', 'song.public': 'マーケット掲載中', 'song.work': '作品',
  'song.instrumental': 'インスト', 'song.vocals': 'ボーカル入り',
  'song.you': 'あなた', 'song.creator': 'クリエイター', 'song.plays': '{n} 回再生',
  'song.like': '♡ {n}', 'song.share': 'シェア ↗', 'song.copied': 'リンクをコピーしました',
  'song.edit': 'AI で再創作 ↗', 'song.download': 'MP3 をダウンロード ↓', 'song.downloadLicensed': 'ライセンス済み MP3 をダウンロード ↓',
  'song.publish': 'マーケットへ公開 ↗', 'song.unpublish': '公開を取りやめ',
  'song.delete': '削除', 'song.confirmDelete': '「{title}」を削除します？取り消せません。',
  'song.license': 'ライセンス購入 · ${price} ↗', 'song.licensing': '決済を開いています…',
  'song.licensesSold': 'マーケットで {n} 件のライセンスが売れました',
  'song.demo': 'デモ環境：音声は合成サンプルです。',
  'song.lyrics': '歌詞', 'song.usage': '利用条件',
  'song.usageBody': '作品ごとに、生成時点の利用条件が記録されています。',
  'song.usageFull': '記録をすべて見る', 'song.backMarket': 'マーケットへ戻る',
  'cover.aria': '「{title}」のカバー',
  'lyrics.instrumental': 'インスト — 表示できる歌詞はありません。',
  'lyrics.estimated': '推定同期', 'lyrics.aligned': '単語同期',
  'lyrics.playFrom': 'ここから再生',

  'card.play': '「{title}」を再生', 'card.pause': '「{title}」を一時停止',
  'card.like': '「{title}」にいいね', 'card.unlike': '「{title}」のいいねを取り消す',
  'card.more': '「{title}」のその他の操作',
  'card.open': '開く', 'card.download': 'MP3 をダウンロード',
  'card.publish': 'マーケットへ公開', 'card.unpublish': '公開を取りやめ', 'card.delete': '削除',
  'card.onMarket': '掲載中', 'card.generating': '生成中…',
  'card.you': 'あなた', 'card.creator': 'クリエイター',

  'player.play': '再生', 'player.pause': '一時停止', 'player.prev': '前へ', 'player.next': '次へ',
  'player.buffering': 'バッファ中…', 'player.error': '再生できません', 'player.queue': '再生キュー',
  'player.expand': '再生画面を開く', 'player.nowPlaying': '再生中', 'player.paused': '一時停止中',
  'player.close': '閉じる',

  'market.eyebrow': 'YUHA マーケット',
  'market.title': 'みんながつくったチャート',
  'market.sub': 'ここにある曲はすべて YUHA のクリエイターが生成し、マーケットに公開したものです。試聴もいいねも、着想を持ち帰って自分の一曲にしても。',
  'market.trending': '人気', 'market.new': '新着',
  'market.all': 'すべて', 'market.instrumental': 'インスト', 'market.vocals': 'ボーカル入り',
  'market.search': '曲やスタイルを検索…', 'market.searchBtn': '検索',
  'market.top10': 'トップ 10', 'market.rankBy': '再生といいねで順位づけ',
  'market.fresh': '新着', 'market.empty': '該当する曲がまだありません。条件を変えるか、ここにふさわしい一曲をつくってみませんか。',
  'market.loadMore': 'もっと見る', 'market.loading': '読み込み中…',
  'market.stats': '{plays} 回再生 · {likes} いいね',

  'lib.title': 'マイ作品', 'lib.new': '新しい創作',
  'lib.all': 'すべて', 'lib.finished': '完成', 'lib.generating': '生成中', 'lib.paused': '一時停止',
  'lib.search': '自分の曲を検索…',
  'lib.empty': 'まだ作品がありません', 'lib.emptySub': '生成した曲はここに置かれます。既定は非公開、公開するまであなたにだけ見えます。',
  'lib.create': '最初の一曲をつくる',
  'lib.loadMore': 'もっと見る', 'lib.loading': '読み込み中…',
  'earn.title': 'マーケット収益', 'earn.share': 'ライセンスごとに {n} を獲得',
  'earn.total': '累計 · {n} 件', 'earn.pending': '確定待ち', 'earn.cleared': '確定済み', 'earn.paid': '支払済み',
  'earn.perTrack': '{n} 件 · {amount}',

  'auth.welcome': 'YUHA へようこそ',
  'auth.sub': '気持ちを書いて、音楽に。Google アカウントで続ける。',
  'auth.google': 'Google で続ける',
  'auth.googleNotConfigured': 'Google ログインは未設定です',
  'auth.googleHint': 'API の環境変数 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI を設定すると、ボタンが自動で表示されます。',
  'auth.or': 'または開発用 ID でログイン',
  'auth.email': 'メールアドレス', 'auth.age': '18 歳以上です',
  'auth.terms': '利用規約とプライバシーポリシーに同意します',
  'auth.marketing': '製品ニュースを受け取る（任意）',
  'auth.continue': '続ける', 'auth.dev': '開発 ID',

  'mfa.title': '二段階認証',
  'mfa.sub': 'Google 認証システムの 6 桁コード（またはリカバリーコード）を入力してください。',
  'mfa.code': 'コード', 'mfa.lost': '端末を失くした場合はリカバリーコードを入力できます。',
  'mfa.verify': '確認してログイン', 'mfa.verifying': '確認中…', 'mfa.restart': 'やり直す',

  'footer.terms': '利用規約', 'footer.privacy': 'プライバシー', 'footer.company': '会社情報',
  'footer.rights': '権利の申立て', 'footer.slogan': 'ときめきに、響きを。',
  'footer.made': '© {year} NetStars Co., Ltd.',
};

const en: Dict = {
  'nav.create': 'Create', 'nav.library': 'My songs', 'nav.market': 'Market',
  'nav.signin': 'Sign in', 'nav.start': 'Start creating',
  'nav.credits': '{n} credits left', 'nav.skip': 'Skip to content',
  'account.mySongs': 'My songs', 'account.billing': 'Billing', 'account.settings': 'Account settings',
  'account.console': 'Console', 'account.signOut': 'Sign out',

  'hero.eyebrow': 'A LITTLE FEELING. YOUR OWN SOUND.',
  'hero.slogan1': 'Let a feeling', 'hero.slogan2': 'echo.',
  'hero.intro': 'Write down a mood, turn it into music for this exact moment.',
  'composer.label': 'What do you want to hear today?',
  'composer.placeholder': 'Seaside at dusk, riding home with a friend. Something light, like wind through a shirt.',
  'composer.format': '30 seconds · instrumental · private',
  'composer.cost': 'Each generation uses 1 credit',
  'composer.credits': '{n} credits available', 'composer.creditsLogin': 'Sign in to see your credits',
  'composer.submit': 'Create music · 1 credit', 'composer.submitting': 'Submitting…',
  'composer.feedback': 'Start with one line, or pick a mood.',
  'composer.moodKept': 'Your words are kept; add a touch of “{mood}” by hand if you like.',
  'composer.moodSeeded': 'A starting point is in — edit it freely.',
  'mood.city': 'City walk', 'mood.sunset': 'Sunset road', 'mood.rain': 'Rain indoors', 'mood.night': 'Late study',
  'mood.city.text': 'A city walk, light tempo. Clean drums and soft synths, like an unplanned weekend afternoon.',
  'mood.sunset.text': 'Sunset road, riding home with a friend. Light, like wind through a shirt.',
  'mood.rain.text': 'Rain in the room, warm piano and gentle ambience. Quiet, but expecting something.',
  'mood.night.text': 'Late-night study, quiet white noise and a faint heartbeat. Focus and calm.',
  'art.h2a': 'One petal.', 'art.h2b': 'A little wind.',
  'art.pa': 'Give what you could not say', 'art.pb': 'to the next melody.',
  'home.echoes': 'Echoes of this moment', 'home.toMarket': 'Browse the market →',

  'wait.heading': 'Your music is on its way.',
  'wait.sub': 'You can leave this page — check “My songs” later.',
  'wait.s1': 'Confirming this creation', 'wait.s2': 'Queued', 'wait.s3': 'Generating your music', 'wait.s4': 'Done — ready to play',
  'wait.done': 'Done', 'wait.doing': 'In progress', 'wait.todo': 'Waiting',
  'wait.failed': 'It did not finish this time; your credit was returned as confirmed by the server. Adjust the words and try again.',
  'wait.goLibrary': 'Go to My songs',

  'song.play': 'Play', 'song.pause': 'Pause',
  'song.private': 'Private', 'song.public': 'On the market', 'song.work': 'Song',
  'song.instrumental': 'Instrumental', 'song.vocals': 'With vocals',
  'song.you': 'you', 'song.creator': 'a creator', 'song.plays': '{n} plays',
  'song.like': '♡ {n}', 'song.share': 'Share ↗', 'song.copied': 'Link copied',
  'song.edit': 'Re-create with AI ↗', 'song.download': 'Download MP3 ↓', 'song.downloadLicensed': 'Download licensed MP3 ↓',
  'song.publish': 'Publish to market ↗', 'song.unpublish': 'Unpublish',
  'song.delete': 'Delete', 'song.confirmDelete': 'Delete “{title}”? This cannot be undone.',
  'song.license': 'License · ${price} ↗', 'song.licensing': 'Opening checkout…',
  'song.licensesSold': '{n} licenses sold on the market',
  'song.demo': 'Demo build: audio is a synthetic sample.',
  'song.lyrics': 'Lyrics', 'song.usage': 'Usage terms',
  'song.usageBody': 'Every song keeps the usage terms that were in force when it was made.',
  'song.usageFull': 'View the full record', 'song.backMarket': 'Back to market',
  'cover.aria': 'Cover for “{title}”',
  'lyrics.instrumental': 'Instrumental — no lyrics to show.',
  'lyrics.estimated': 'Estimated sync', 'lyrics.aligned': 'Word-synced',
  'lyrics.playFrom': 'Play from here',

  'card.play': 'Play “{title}”', 'card.pause': 'Pause “{title}”',
  'card.like': 'Like “{title}”', 'card.unlike': 'Unlike “{title}”',
  'card.more': 'More actions for “{title}”',
  'card.open': 'Open', 'card.download': 'Download MP3',
  'card.publish': 'Publish to market', 'card.unpublish': 'Unpublish', 'card.delete': 'Delete',
  'card.onMarket': 'On market', 'card.generating': 'Generating…',
  'card.you': 'you', 'card.creator': 'creator',

  'player.play': 'Play', 'player.pause': 'Pause', 'player.prev': 'Previous', 'player.next': 'Next',
  'player.buffering': 'buffering…', 'player.error': 'playback error', 'player.queue': 'queue',
  'player.expand': 'Open now playing', 'player.nowPlaying': 'Now playing', 'player.paused': 'Paused',
  'player.close': 'Close',

  'market.eyebrow': 'YUHA MARKET',
  'market.title': 'A chart made by everyone',
  'market.sub': 'Every song here was generated by a YUHA creator and published to the market. Play it, like it, or take the idea and make your own.',
  'market.trending': 'Trending', 'market.new': 'Newest',
  'market.all': 'All', 'market.instrumental': 'Instrumental', 'market.vocals': 'With vocals',
  'market.search': 'Search songs or styles…', 'market.searchBtn': 'Search',
  'market.top10': 'Top 10', 'market.rankBy': 'ranked by plays and likes',
  'market.fresh': 'Fresh drops', 'market.empty': 'No songs match yet. Try another filter — or make the song that belongs here.',
  'market.loadMore': 'Load more', 'market.loading': 'Loading…',
  'market.stats': '{plays} plays · {likes} likes',

  'lib.title': 'My songs', 'lib.new': 'New song',
  'lib.all': 'All', 'lib.finished': 'Finished', 'lib.generating': 'Generating', 'lib.paused': 'Paused',
  'lib.search': 'Search your songs…',
  'lib.empty': 'Nothing here yet', 'lib.emptySub': 'Songs you generate live here — private until you publish them.',
  'lib.create': 'Create your first song',
  'lib.loadMore': 'Load more', 'lib.loading': 'Loading…',
  'earn.title': 'Market earnings', 'earn.share': 'you earn {n}% of each sale',
  'earn.total': 'total · {n} sales', 'earn.pending': 'pending', 'earn.cleared': 'cleared', 'earn.paid': 'paid out',
  'earn.perTrack': '{n} licenses · {amount}',

  'auth.welcome': 'Welcome to YUHA',
  'auth.sub': 'Write a feeling, make it music. Continue with Google.',
  'auth.google': 'Continue with Google',
  'auth.googleNotConfigured': 'Google sign-in is not configured',
  'auth.googleHint': 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in the API environment — the button appears automatically.',
  'auth.or': 'or use a development identity',
  'auth.email': 'Email', 'auth.age': 'I am 18 or older',
  'auth.terms': 'I agree to the Terms and Privacy Policy',
  'auth.marketing': 'Send me product news (optional)',
  'auth.continue': 'Continue', 'auth.dev': 'Development login',

  'mfa.title': 'Two-factor verification',
  'mfa.sub': 'Enter the 6-digit code from Google Authenticator (or a recovery code) to finish signing in.',
  'mfa.code': 'Code', 'mfa.lost': 'Lost your phone? Enter a recovery code instead.',
  'mfa.verify': 'Verify & sign in', 'mfa.verifying': 'Verifying…', 'mfa.restart': 'Start over',

  'footer.terms': 'Terms', 'footer.privacy': 'Privacy', 'footer.company': 'Company',
  'footer.rights': 'Report content', 'footer.slogan': 'Let a feeling echo.',
  'footer.made': '© {year} NetStars Co., Ltd.',
};

const DICTS: Record<Lang, Dict> = { zh, ja, en };

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY) as Lang | null;
    if (saved && saved in DICTS) return saved;
  } catch {
    /* ignore */
  }
  const nav = navigator.language?.toLowerCase() ?? 'zh';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('en')) return 'en';
  return 'zh';
}

interface I18nApi {
  lang: Lang;
  setLang(lang: Lang): void;
  t(key: string, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja' : 'en';
  }, [lang]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      let text = DICTS[lang][key] ?? zh[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
      }
      return text;
    },
    [lang],
  );

  const api = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside an I18nProvider');
  return ctx;
}
