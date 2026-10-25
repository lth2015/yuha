/**
 * #27 · iPhone first-sound probe.
 *
 * One method per page load (`?method=`), because an audio session that one
 * method changed may not change back. Trials ride in the URL fragment across
 * those reloads; nothing is stored and nothing is sent anywhere.
 *
 * Everything a tester typed is rendered with textContent: a trial list can
 * arrive in a link someone else made.
 */
import { audioSessionAvailable, resumeAgain, strike, unlockProblems } from './probe/audio.ts';
import {
  decodeTrials,
  encodeTrials,
  EVIDENCE_HEADER,
  evidenceRow,
  latencyEstimate,
  METHODS,
  readUserAgent,
  verdict,
  type Heard,
  type Method,
  type Route,
  type SilentSwitch,
  type Trial,
} from './probe/probe.ts';
import './style.css';

const METHOD_LABEL: Record<Method, string> = {
  none: '对照：不做任何处理',
  'audio-session': 'A · audioSession = playback',
  'silent-element': 'B · 静音 <audio> 循环',
  both: 'A + B',
};

const VERDICT_TEXT: Record<ReturnType<typeof verdict>['status'], string> = {
  incomplete: '尚未完成：需要在 iPhone、静音键开启下，先有一次「对照」听不到，再至少测一个方案。',
  go: 'GO：静音键开启时，下列方案能发声，且对照确实无声。',
  'no-go': 'NO-GO：静音键开启时，所有已测方案都没有可靠发声。按 #27，暂停后续声音相关的票，不得绕过。',
  'control-not-muted': '无效：对照在静音键开启时仍有声音，说明这台设备上没有复现问题。请确认静音键确实开启，再重测。',
};

const params = new URLSearchParams(location.search);
const method: Method = (METHODS as readonly string[]).includes(params.get('method') ?? '') ? (params.get('method') as Method) : 'none';
let trials: Trial[] = decodeTrials(location.hash);
const env = readUserAgent(navigator);
const last = trials.at(-1);

// Props are assigned as DOM properties (textContent, never innerHTML).
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function select<T extends string>(label: string, options: [T, string][], initial: T) {
  const s = el('select');
  for (const [value, text] of options) s.append(el('option', { value, textContent: text, selected: value === initial }));
  return { field: el('label', { className: 'field' }, el('span', { textContent: label }), s), get: () => s.value as T };
}

function input(label: string, initial: string, hint?: string) {
  const i = el('input', { value: initial, type: 'text' });
  const children: (Node | string)[] = [el('span', { textContent: label }), i];
  if (hint) children.push(el('small', { textContent: hint }));
  return { field: el('label', { className: 'field' }, ...children), get: () => i.value.trim() };
}

const linkFor = (m: Method) => `?method=${m}${trials.length ? `#${encodeTrials(trials)}` : ''}`;

/* ---------- environment ---------- */

const envLine = el(
  'p',
  { className: 'env' },
  `${env.platform} · ${env.browser} · UA 报告系统 ${env.uaOsVersion ?? '—'} · HTTPS ${isSecureContext ? '是' : '否（结果无效）'} · audioSession API ${audioSessionAvailable() ? '有' : '无'}`,
);

/* ---------- methods ---------- */

const methodNav = el('nav', { className: 'methods' });
function renderMethods() {
  methodNav.replaceChildren(
    ...METHODS.map((m) => el('a', { href: linkFor(m), textContent: METHOD_LABEL[m], className: m === method ? 'on' : '' })),
  );
}

/* ---------- the pad ---------- */

let pending: { latencyMs: number | null; outputLatencyMs: number | null; state: string } | null = null;
/** Notes about the taps since the last recorded trial; cleared when one is recorded. */
let tapNotes: string[] = [];
const notes = () => [...unlockProblems, ...tapNotes];
const readout = el('p', { className: 'readout', textContent: '还没有触碰。' });
const pad = el('div', { className: 'pad', role: 'button', tabIndex: 0, ariaLabel: '触碰发声' }, el('span', { textContent: '触碰这里' }));

pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const rect = pad.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const pointerAt = e.timeStamp;
  const s = strike(method, x);
  pad.classList.remove('ring');
  void pad.offsetWidth; // restart the ring animation
  pad.classList.add('ring');
  // If the context never starts, the tester must still be able to record that.
  const stalled = setTimeout(() => {
    pending = { latencyMs: null, outputLatencyMs: null, state: `${s.contextStateAtGesture}, never running` };
    readout.textContent = `AudioContext 1.5 秒内没有启动${notes().length ? ` · ${notes().join('；')}` : ''}`;
    record.hidden = false;
  }, 1500);
  void s.readyAt.then((readyAt) => {
    clearTimeout(stalled);
    const l = latencyEstimate({ pointerAt, scheduledAt: readyAt, baseLatency: s.baseLatency, outputLatency: s.outputLatency });
    pending = { latencyMs: l.codePathMs, outputLatencyMs: l.reportedOutputMs, state: s.contextStateAtGesture };
    readout.textContent =
      `代码路径 ${l.codePathMs} ms · 系统报告输出 ${l.reportedOutputMs ?? '?'} ms · 合计估计 ${l.totalMs ?? '?'} ms` +
      ` · 触碰时 AudioContext：${s.contextStateAtGesture}` +
      (notes().length ? ` · ${notes().join('；')}` : '');
    record.hidden = false;
  });
});
pad.addEventListener('click', () => {
  const retry = 'pointerdown alone did not start audio; retried on click';
  if (resumeAgain() && !tapNotes.includes(retry)) tapNotes.push(retry);
});

/* ---------- recording a trial ---------- */

const device = input('设备型号', last?.device ?? '', '例如 iPhone 15 Pro（UA 不包含型号）');
const os = input('系统版本', last?.osVersion ?? env.uaOsVersion ?? '', '以「设置 → 通用 → 关于本机」为准：Safari 可能冻结 UA 中的版本');
const sw = select<SilentSwitch>('静音键', [['on', '开（静音）'], ['off', '关'], ['unknown', '不适用 / 不确定']], last?.silentSwitch ?? 'on');
const route = select<Route>('音频输出', [['speaker', '扬声器'], ['wired', '有线耳机'], ['bluetooth', '蓝牙'], ['other', '其他']], last?.route ?? 'speaker');
const note = input('备注（可选）', '');

const heardButtons = el('div', { className: 'heard' });
const record = el('section', { className: 'record', hidden: true }, el('h2', { textContent: '刚才听到了吗？' }), heardButtons);
for (const [value, text] of [['yes', '听到了'], ['no', '没听到'], ['odd', '异常（断续、延迟很大、失真）']] as [Heard, string][]) {
  heardButtons.append(
    el('button', {
      type: 'button',
      textContent: text,
      onclick: () => {
        trials = [
          ...trials,
          {
            device: device.get() || '未填写',
            platform: env.platform,
            osVersion: os.get() || '未填写',
            browser: env.browser,
            silentSwitch: sw.get(),
            route: route.get(),
            method,
            secureContext: isSecureContext,
            audioSessionAvailable: audioSessionAvailable(),
            latencyMs: pending?.latencyMs ?? null,
            outputLatencyMs: pending?.outputLatencyMs ?? null,
            heard: value,
            note: [note.get(), pending ? `context ${pending.state}` : '', ...notes()].filter(Boolean).join('; '),
          },
        ];
        history.replaceState(null, '', `${location.search}#${encodeTrials(trials)}`);
        record.hidden = true;
        pending = null;
        tapNotes = [];
        readout.textContent = '已记录。可以再触碰一次，或切换方案。';
        renderResults();
        renderMethods();
      },
    }),
  );
}

/* ---------- results ---------- */

const verdictBox = el('div', { className: 'verdict' });
const table = el('pre', { className: 'evidence' });
const copy = el('button', { type: 'button', textContent: '复制证据（Markdown，贴到 #27）' });
copy.addEventListener('click', () => {
  const text = `${EVIDENCE_HEADER}\n${trials.map(evidenceRow).join('\n')}\n\nVerdict: ${verdict(trials).status}`;
  navigator.clipboard.writeText(text).then(
    () => (copy.textContent = '已复制'),
    () => {
      // Clipboard refused (e.g. not a secure context): select the text instead.
      const range = document.createRange();
      range.selectNodeContents(table);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      copy.textContent = '无法自动复制，已选中，请手动复制';
    },
  );
});
const clear = el('button', { type: 'button', textContent: '清空记录', className: 'quiet' });
clear.addEventListener('click', () => {
  if (!confirm('清空所有记录？')) return;
  trials = [];
  history.replaceState(null, '', location.search);
  renderResults();
  renderMethods();
});

function renderResults() {
  const v = verdict(trials);
  verdictBox.className = `verdict ${v.status}`;
  verdictBox.replaceChildren(
    el('strong', { textContent: VERDICT_TEXT[v.status] }),
    ...(v.workingMethods.length ? [el('p', { textContent: v.workingMethods.map((m) => METHOD_LABEL[m]).join('、') })] : []),
  );
  table.textContent = trials.length ? `${EVIDENCE_HEADER}\n${trials.map(evidenceRow).join('\n')}` : '还没有记录。';
}

/* ---------- page ---------- */

document.querySelector('#app')!.replaceChildren(
  el('h1', { textContent: 'YUHA Air · 第一声测试' }),
  el('p', { className: 'lede', textContent: '#27 Go / No-Go：iPhone 静音键开启时，网页实时合成的声音能否被听见。' }),
  envLine,
  el(
    'ol',
    { className: 'steps' },
    el('li', { textContent: '先选「对照」，静音键开启，触碰一次。正常情况下应当听不到。' }),
    el('li', { textContent: '静音键保持开启，依次切换 A、B、A + B，每个方案触碰一次并记录。' }),
    el('li', { textContent: '静音键关闭，每个方案再测一次。然后换浏览器、iPad、桌面。' }),
    el('li', { textContent: '结果可疑时，关闭标签页、用复制的链接重新打开再测：切换方案只会重新加载页面。' }),
  ),
  el('h2', { textContent: `当前方案：${METHOD_LABEL[method]}` }),
  methodNav,
  el('div', { className: 'fields' }, device.field, os.field, sw.field, route.field, note.field),
  pad,
  readout,
  record,
  el('h2', { textContent: '结论' }),
  verdictBox,
  el('h2', { textContent: '证据' }),
  table,
  el('div', { className: 'actions' }, copy, clear),
  el('p', {
    className: 'fine',
    textContent: '延迟为估计值：代码路径加上浏览器自报的输出延迟，不是声学延迟。需要声学延迟时，用另一台手机的慢动作视频拍下触碰与发声。本页不发送任何请求，不写入任何存储。',
  }),
);
renderMethods();
renderResults();
