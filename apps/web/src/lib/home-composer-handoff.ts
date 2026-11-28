const KEY = 'yuha.home-composer-handoff';

export interface HomeComposerDraft {
  prompt: string;
  instrumental: boolean;
  styles: string[];
}

/** The sign-in round trip keeps the destination URL. Store the draft in its tab, outside that URL. */
export function rememberHomeComposerDraft(draft: HomeComposerDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // In the same signed-in navigation, the router state can still carry it.
  }
}

export function readHomeComposerDraft(): HomeComposerDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<HomeComposerDraft> | null;
    return draft && typeof draft.prompt === 'string' && typeof draft.instrumental === 'boolean'
      && Array.isArray(draft.styles) && draft.styles.every((style) => typeof style === 'string')
      ? { prompt: draft.prompt, instrumental: draft.instrumental, styles: draft.styles }
      : null;
  } catch {
    return null;
  }
}

export function clearHomeComposerDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage may be unavailable.
  }
}
