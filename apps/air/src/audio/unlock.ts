/**
 * Making Web Audio audible on an iPhone whose silent switch is on.
 *
 * iOS plays Web Audio on the ringer channel, so with the switch on it is
 * silent and reports no error. #27 tested two fixes on a real iPhone (iOS
 * 18.7, inside the Claude app's page viewer):
 *
 * - a looping silent <audio> element started in the same gesture: HEARD.
 *   A playing media element moves the page's audio session to the media
 *   channel, and Web Audio goes with it.
 * - `navigator.audioSession.type = 'playback'`: not heard there, possibly
 *   because that viewer does not expose it. Still tried, as it costs nothing.
 *
 * Safari itself is not yet confirmed (#27). Call from the gesture handler
 * itself, never after an await: iOS starts media only from a user gesture.
 */
type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export const audioSessionAvailable = (): boolean =>
  typeof navigator !== 'undefined' && typeof (navigator as AudioSessionNavigator).audioSession === 'object';

let silent: HTMLAudioElement | null = null;
let unlocked = false;

/** Half a second of 8-bit mono silence as a WAV, built here so no asset is fetched. */
function silentWavUrl(): string {
  const rate = 8000;
  const samples = rate / 2;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) v.setUint8(44 + i, 128); // 8-bit silence is the midpoint
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * What the browser refused while unlocking. Unlocking happens once per page
 * load, so these hold for everything played on this load.
 */
export const unlockProblems: string[] = [];

export function unlockAudio(use: { audioSession: boolean; silentElement: boolean }) {
  if (unlocked) return;
  unlocked = true;
  if (use.audioSession) {
    const nav = navigator as AudioSessionNavigator;
    if (nav.audioSession) {
      try {
        nav.audioSession.type = 'playback';
      } catch (e) {
        unlockProblems.push(`audioSession: ${(e as Error).message}`);
      }
    } else {
      unlockProblems.push('audioSession: not exposed');
    }
  }
  if (use.silentElement) {
    silent = new Audio(silentWavUrl());
    silent.loop = true;
    silent.setAttribute('playsinline', '');
    silent.play().catch((e: Error) => unlockProblems.push(`silent element: ${e.name}`));
  }
}
