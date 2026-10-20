/**
 * Whether the player may route its audio through Web Audio.
 *
 * On iPhone and iPad it may not: iOS plays Web Audio on the ringer channel,
 * so with the silent switch on a song "played" in silence while the progress
 * bar moved. A plain <audio> element plays on the media channel. iPadOS
 * reports itself as a Mac, and every iOS browser is WebKit.
 */
import { describe, expect, it } from 'vitest';
import { mayTapAudio } from '../apps/web/src/lib/beat.js';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};

describe('routing the player through Web Audio', () => {
  it('never on iPhone, in Safari or in Chrome (both are WebKit)', () => {
    expect(mayTapAudio({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 })).toBe(false);
    expect(mayTapAudio({ userAgent: UA.iphoneChrome, maxTouchPoints: 5 })).toBe(false);
  });

  it('never on an iPad that reports itself as a Mac', () => {
    expect(mayTapAudio({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 })).toBe(false);
  });

  it('still on a real Mac, Android and Windows, where the beat visuals work', () => {
    expect(mayTapAudio({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toBe(true);
    expect(mayTapAudio({ userAgent: UA.androidChrome, maxTouchPoints: 5 })).toBe(true);
    expect(mayTapAudio({ userAgent: UA.windowsChrome, maxTouchPoints: 0 })).toBe(true);
  });
});
