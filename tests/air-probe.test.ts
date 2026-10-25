/**
 * The iPhone first-sound probe (#27): what it records and what it concludes.
 *
 * The probe decides whether air composition can exist on an iPhone at all, so
 * the part that turns trials into a verdict is tested here rather than read off
 * a screen. The rule that matters most is the control: a method only "works
 * with the silent switch on" if, on the same kind of device, *no* method with
 * the switch on was silent. Without that, a pass might just mean the switch
 * was off, or that iOS stopped muting Web Audio — and the probe would declare
 * a fix for a problem it never reproduced.
 *
 * No database: pure functions only.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseMethod,
  decodeTrials,
  encodeTrials,
  evidenceRow,
  EVIDENCE_HEADER,
  latencyEstimate,
  readUserAgent,
  verdict,
  type Trial,
} from '../apps/air/src/probe/probe.js';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};

const trial = (over: Partial<Trial>): Trial => ({
  device: 'iPhone 15',
  platform: 'iPhone',
  osVersion: '18.5',
  browser: 'Safari',
  silentSwitch: 'on',
  route: 'speaker',
  method: 'none',
  secureContext: true,
  embedded: false,
  audioSessionAvailable: true,
  latencyMs: 40,
  outputLatencyMs: null,
  heard: 'no',
  note: '',
  ...over,
});

describe('readUserAgent', () => {
  it('names an iPhone and the browser behind the shared WebKit engine', () => {
    expect(readUserAgent({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 })).toEqual({
      platform: 'iPhone',
      uaOsVersion: '18.5',
      browser: 'Safari',
    });
    expect(readUserAgent({ userAgent: UA.iphoneChrome, maxTouchPoints: 5 }).browser).toBe('Chrome (iOS)');
  });

  it('recognises an iPad that reports itself as a Mac', () => {
    expect(readUserAgent({ userAgent: UA.macSafari, maxTouchPoints: 5 }).platform).toBe('iPad');
    expect(readUserAgent({ userAgent: UA.macSafari, maxTouchPoints: 0 }).platform).toBe('Mac');
  });

  it('names desktop browsers', () => {
    expect(readUserAgent({ userAgent: UA.windowsChrome })).toEqual({
      platform: 'Windows',
      uaOsVersion: null,
      browser: 'Chrome',
    });
    expect(readUserAgent({ userAgent: UA.macSafari, maxTouchPoints: 0 }).browser).toBe('Safari');
    expect(readUserAgent({ userAgent: UA.linuxChrome })).toEqual({ platform: 'Linux', uaOsVersion: null, browser: 'Chrome' });
  });
});

describe('chooseMethod', () => {
  it('takes a bare #token first, because inside an artifact frame that is all a link can carry', () => {
    expect(chooseMethod({ hash: '#silent-element', search: '?method=both', stored: 'audio-session' })).toBe('silent-element');
  });

  it('falls back to ?method= for the dev server, then to what this browser last chose', () => {
    expect(chooseMethod({ hash: '', search: '?method=both', stored: 'audio-session' })).toBe('both');
    expect(chooseMethod({ hash: '', search: '', stored: 'audio-session' })).toBe('audio-session');
  });

  it('starts with the control when nothing names a known method', () => {
    expect(chooseMethod({ hash: '#nonsense', search: '?method=x', stored: 'bogus' })).toBe('none');
    expect(chooseMethod({ hash: '', search: '', stored: null })).toBe('none');
  });
});

describe('latencyEstimate', () => {
  it('adds what the system reports to the time our own code took', () => {
    expect(latencyEstimate({ pointerAt: 1000, scheduledAt: 1012, baseLatency: 0.005, outputLatency: 0.02 })).toEqual({
      codePathMs: 12,
      reportedOutputMs: 25,
      totalMs: 37,
    });
  });

  it('says it does not know rather than counting a missing figure as zero', () => {
    expect(latencyEstimate({ pointerAt: 1000, scheduledAt: 1012, baseLatency: undefined, outputLatency: undefined })).toEqual({
      codePathMs: 12,
      reportedOutputMs: null,
      totalMs: null,
    });
  });
});

describe('evidence rows', () => {
  it('has one cell per header column', () => {
    const cells = (line: string) => line.split(/(?<!\\)\|/).length;
    expect(cells(evidenceRow(trial({})))).toBe(cells(EVIDENCE_HEADER.split('\n')[0]!));
  });

  it('keeps free text from breaking the table', () => {
    const row = evidenceRow(trial({ note: 'faint | then\nloud', device: 'a|b' }));
    expect(row).not.toContain('\n');
    expect(row).toContain('faint \\| then loud');
    expect(row).toContain('a\\|b');
  });
});

describe('carrying trials across a reload', () => {
  it('round-trips', () => {
    const trials = [trial({}), trial({ method: 'silent-element', heard: 'yes', note: '静音键 開 ✓' })];
    expect(decodeTrials(encodeTrials(trials))).toEqual(trials);
  });

  it('treats anything malformed as no trials', () => {
    for (const bad of ['', '#', 'not-base64!!', encodeTrials([]).slice(0, 3), btoa('{"x":1}'), btoa('[{"x":1}]'), 'A'.repeat(200_000)]) {
      expect(decodeTrials(bad)).toEqual([]);
    }
  });
});

describe('verdict', () => {
  const control = trial({ method: 'none', heard: 'no' });

  it('is incomplete until the silent switch has been shown to mute the control', () => {
    expect(verdict([]).status).toBe('incomplete');
    expect(verdict([trial({ method: 'silent-element', heard: 'yes' })]).status).toBe('incomplete');
    // A control with the switch off proves nothing about the switch.
    expect(verdict([trial({ silentSwitch: 'off', heard: 'yes' }), trial({ method: 'silent-element', heard: 'yes' })]).status).toBe(
      'incomplete',
    );
  });

  it('is go when a method is heard with the switch on and the control was silent', () => {
    const v = verdict([control, trial({ method: 'silent-element', heard: 'yes' }), trial({ method: 'audio-session', heard: 'no' })]);
    expect(v.status).toBe('go');
    expect(v.workingMethods).toEqual(['silent-element']);
  });

  it('is no-go when every method tried with the switch on was silent', () => {
    const v = verdict([control, trial({ method: 'silent-element', heard: 'no' }), trial({ method: 'audio-session', heard: 'odd' })]);
    expect(v.status).toBe('no-go');
    expect(v.workingMethods).toEqual([]);
  });

  it('is incomplete while a method has a control but no trial of its own', () => {
    expect(verdict([control]).status).toBe('incomplete');
  });

  it('flags a control that was heard with the switch on instead of calling it a pass', () => {
    expect(verdict([trial({ method: 'none', heard: 'yes' }), trial({ method: 'silent-element', heard: 'yes' })]).status).toBe(
      'control-not-muted',
    );
  });

  it('only counts iPhone trials, which is where the switch exists', () => {
    const elsewhere = { platform: 'Mac' as const, device: 'MacBook' };
    expect(verdict([trial({ ...elsewhere }), trial({ ...elsewhere, method: 'silent-element', heard: 'yes' })]).status).toBe(
      'incomplete',
    );
  });
});
