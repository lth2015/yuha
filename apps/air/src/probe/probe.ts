/**
 * The iPhone first-sound probe (#27): environment, evidence and verdict.
 *
 * Air composition synthesises sound live, so it needs Web Audio — and on an
 * iPhone, Web Audio plays on the ringer channel: with the silent switch on it
 * is silent, with no error (see apps/web/src/lib/beat.ts, which avoids Web
 * Audio on iOS for exactly this reason). The probe tries candidate fixes on a
 * real device and records what a person actually heard.
 *
 * Nothing here touches the DOM or audio, so the verdict can be tested.
 */

export type Method = 'none' | 'audio-session' | 'silent-element' | 'both';
export const METHODS: readonly Method[] = ['none', 'audio-session', 'silent-element', 'both'];

export type Heard = 'yes' | 'no' | 'odd';
export type SilentSwitch = 'on' | 'off' | 'unknown';
export type Route = 'speaker' | 'wired' | 'bluetooth' | 'other';

export type Trial = {
  /** Typed by the tester: a user agent does not name the model. */
  device: string;
  platform: string;
  /** Typed by the tester from Settings: Safari may freeze the version its UA reports. */
  osVersion: string;
  browser: string;
  silentSwitch: SilentSwitch;
  route: Route;
  method: Method;
  secureContext: boolean;
  audioSessionAvailable: boolean;
  latencyMs: number | null;
  outputLatencyMs: number | null;
  heard: Heard;
  note: string;
};

export function readUserAgent(nav: { userAgent: string; maxTouchPoints?: number }): {
  platform: string;
  uaOsVersion: string | null;
  browser: string;
} {
  const ua = nav.userAgent;
  const ios = /\b(iPhone|iPad|iPod)\b.*?OS (\d+)_(\d+)/.exec(ua);
  // iPadOS asks for desktop sites by default and then reports itself as a Mac.
  const ipadAsMac = /\bMacintosh\b/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
  const platform = ios
    ? ios[1]!
    : ipadAsMac
      ? 'iPad'
      : /\bAndroid\b/.test(ua)
        ? 'Android'
        : /\bWindows\b/.test(ua)
          ? 'Windows'
          : /\bMacintosh\b/.test(ua)
            ? 'Mac'
            : /\bLinux\b/.test(ua)
              ? 'Linux'
              : 'other';
  const browser = /\bCriOS\//.test(ua)
    ? 'Chrome (iOS)'
    : /\bFxiOS\//.test(ua)
      ? 'Firefox (iOS)'
      : /\bEdgiOS\//.test(ua)
        ? 'Edge (iOS)'
        : /\bEdg\//.test(ua)
          ? 'Edge'
          : /\bFirefox\//.test(ua)
            ? 'Firefox'
            : /\bChrome\//.test(ua)
              ? 'Chrome'
              : /\bSafari\//.test(ua)
                ? 'Safari'
                : 'other';
  return { platform, uaOsVersion: ios ? `${ios[2]}.${ios[3]}` : null, browser };
}

/**
 * Our code's share of the delay plus what the browser reports for its own.
 * This is not acoustic latency — only a microphone or a slow-motion video can
 * measure that — and a figure the browser does not report is unknown, not 0.
 */
export function latencyEstimate(input: {
  pointerAt: number;
  scheduledAt: number;
  baseLatency: number | undefined;
  outputLatency: number | undefined;
}): { codePathMs: number; reportedOutputMs: number | null; totalMs: number | null } {
  const codePathMs = Math.round(input.scheduledAt - input.pointerAt);
  const known = typeof input.baseLatency === 'number' && typeof input.outputLatency === 'number';
  const reportedOutputMs = known ? Math.round((input.baseLatency! + input.outputLatency!) * 1000) : null;
  return { codePathMs, reportedOutputMs, totalMs: reportedOutputMs === null ? null : codePathMs + reportedOutputMs };
}

const COLUMNS: readonly [string, (t: Trial) => string][] = [
  ['device', (t) => t.device],
  ['platform', (t) => t.platform],
  ['iOS / OS', (t) => t.osVersion],
  ['browser', (t) => t.browser],
  ['silent switch', (t) => t.silentSwitch],
  ['route', (t) => t.route],
  ['method', (t) => t.method],
  ['HTTPS', (t) => (t.secureContext ? 'yes' : 'NO')],
  ['audioSession API', (t) => (t.audioSessionAvailable ? 'yes' : 'no')],
  ['code-path ms', (t) => (t.latencyMs === null ? '?' : String(t.latencyMs))],
  ['reported output ms', (t) => (t.outputLatencyMs === null ? '?' : String(t.outputLatencyMs))],
  ['heard', (t) => t.heard],
  ['note', (t) => t.note],
];

const cell = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

export const EVIDENCE_HEADER = `| ${COLUMNS.map((c) => c[0]).join(' | ')} |\n|${COLUMNS.map(() => ' --- |').join('')}`;

export function evidenceRow(t: Trial): string {
  return `| ${COLUMNS.map(([, get]) => cell(get(t))).join(' | ')} |`;
}

/** Trials ride in the URL fragment across the reload between methods: no storage, no server. */
const MAX_FRAGMENT = 64_000;

export function encodeTrials(trials: Trial[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(trials));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);
const numOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));

function isTrial(v: unknown): v is Trial {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    ['device', 'platform', 'osVersion', 'browser', 'note'].every((k) => typeof t[k] === 'string') &&
    oneOf(t.silentSwitch, ['on', 'off', 'unknown'] as const) &&
    oneOf(t.route, ['speaker', 'wired', 'bluetooth', 'other'] as const) &&
    oneOf(t.method, METHODS) &&
    oneOf(t.heard, ['yes', 'no', 'odd'] as const) &&
    typeof t.secureContext === 'boolean' &&
    typeof t.audioSessionAvailable === 'boolean' &&
    numOrNull(t.latencyMs) &&
    numOrNull(t.outputLatencyMs)
  );
}

export function decodeTrials(fragment: string): Trial[] {
  const raw = fragment.replace(/^#/, '');
  if (!raw || raw.length > MAX_FRAGMENT) return [];
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return Array.isArray(parsed) && parsed.every(isTrial) ? parsed : [];
  } catch {
    return [];
  }
}

export type Verdict = {
  status: 'incomplete' | 'go' | 'no-go' | 'control-not-muted';
  workingMethods: Method[];
};

/**
 * Go only if, on an iPhone with the switch on, the control (no method) was
 * silent and some method was heard. A heard control means the switch did not
 * mute this device, so nothing was reproduced and nothing can have been fixed.
 */
export function verdict(trials: Trial[]): Verdict {
  const switchOn = trials.filter((t) => t.platform === 'iPhone' && t.silentSwitch === 'on');
  const controls = switchOn.filter((t) => t.method === 'none');
  const tried = switchOn.filter((t) => t.method !== 'none');
  if (controls.some((t) => t.heard === 'yes')) return { status: 'control-not-muted', workingMethods: [] };
  if (!controls.some((t) => t.heard === 'no') || tried.length === 0) return { status: 'incomplete', workingMethods: [] };
  const workingMethods = METHODS.filter((m) => tried.some((t) => t.method === m && t.heard === 'yes'));
  return { status: workingMethods.length ? 'go' : 'no-go', workingMethods };
}
