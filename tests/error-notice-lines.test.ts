/**
 * One reason, not three.
 *
 * A description over the length limit produced a panel that read, in order:
 *
 *   This cannot be used to generate
 *   Rewrite it in terms of mood, instruments and tempo. If the decision looks
 *     wrong, you can report it.
 *   Keep the description within the length limit.
 *   If you think this decision is wrong, you can report it here. …
 *
 * The first line is advice for a different refusal — the prompt was not about
 * the wrong things, it was too long — and it is read first, so it is the one
 * acted on. The second line is the actual reason. The third repeats the report
 * sentence already in the first.
 *
 * `err.PROMPT_BLOCKED.next` was written as a generic next step, before the
 * server returned a specific hint; it is near word-for-word `prompt.rewriteAsMood`.
 * It belongs as a fallback for when no hint arrives, not stacked on top of one.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../apps/web/src/lib/api.js';
import {
  FIELDS_IN_MORE_PANEL,
  focusFieldFor,
  messageFor,
  nextLineKey,
  PROMPT_HINT_KEYS,
} from '../apps/web/src/lib/messages.js';

describe('which next-step line an error panel shows', () => {
  it('prefers the server hint over the generic advice', () => {
    expect(nextLineKey('err.PROMPT_BLOCKED.next', 'prompt.tooLong')).toBe('prompt.tooLong');
  });

  it('falls back to the generic advice when no hint arrives', () => {
    expect(nextLineKey('err.PROMPT_BLOCKED.next', undefined)).toBe('err.PROMPT_BLOCKED.next');
    expect(nextLineKey('err.PROMPT_BLOCKED.next', '')).toBe('err.PROMPT_BLOCKED.next');
  });

  it('ignores a hint key that is not one of ours', () => {
    // The hint names a dictionary key and is rendered as one, so an arbitrary
    // string from a response must never reach `t()`.
    for (const bogus of ['prompt.somethingNew', 'common.retry', '../../etc/passwd', 'nav.signin']) {
      expect(nextLineKey('err.PROMPT_BLOCKED.next', bogus)).toBe('err.PROMPT_BLOCKED.next');
    }
  });

  it('accepts every hint the allowlist names', () => {
    for (const key of PROMPT_HINT_KEYS) {
      expect(nextLineKey('err.PROMPT_BLOCKED.next', key)).toBe(key);
    }
  });

  it('leaves errors that are not prompt blocks alone', () => {
    expect(nextLineKey('err.INTERNAL_ERROR.next', undefined)).toBe('err.INTERNAL_ERROR.next');
  });
});

/**
 * A refused *title* is not a refused prompt.
 *
 * Rename reuses PROMPT_BLOCKED, because the rules and the appeal machinery are
 * the same. The words were not. A title with a URL in it produced:
 *
 *   This content cannot be used to generate
 *   URLs are not accepted... Describe it with mood and instruments.
 *
 * Nothing was being generated — the song already exists — and "describe it with
 * mood and instruments" is advice for the description box, which is not on the
 * page. That is the same defect this file was opened for, arriving by a new
 * route: the reader is handed the next step for a different refusal.
 */
const blocked = (field: string, hintKey?: string) =>
  new ApiError('PROMPT_BLOCKED', 'blocked', 422, { field, hintKey });

describe('a refused title says so in its own words', () => {
  it('does not tell the reader their title cannot be generated', () => {
    const title = messageFor(blocked('title'));
    const prompt = messageFor(blocked('prompt'));
    expect(title.titleKey).not.toBe(prompt.titleKey);
    expect(title.titleKey).toBe('err.PROMPT_BLOCKED.titleField.title');
    expect(title.tone).toBe(prompt.tone);
  });

  it('falls back to title-shaped advice, not description-shaped advice', () => {
    const title = messageFor(blocked('title'));
    expect(nextLineKey(title.nextKey, undefined)).toBe('err.PROMPT_BLOCKED.titleField.next');
  });

  it('leaves every other blocked field exactly as it was', () => {
    for (const field of ['prompt', 'lyrics', undefined]) {
      expect(messageFor(blocked(field as string)).titleKey).toBe('err.PROMPT_BLOCKED.title');
    }
  });

  it('accepts the title-specific hints the server can now send', () => {
    for (const key of ['title.tooLong', 'title.noUrl', 'title.rewriteAsName']) {
      expect(PROMPT_HINT_KEYS as readonly string[]).toContain(key);
      expect(nextLineKey('err.PROMPT_BLOCKED.titleField.next', key)).toBe(key);
    }
  });
});

/**
 * Which box the composer sends the writer back to.
 *
 * `fieldForError` lived inside Create.tsx, where nothing could reach it, and
 * two things had gone wrong unnoticed.
 *
 * It did not know about `field: 'title'`, which the server started sending when
 * titles began to be screened. A blocked title fell through to the catch-all
 * and focused the *description* — the precise bug this function was written to
 * fix, reintroduced from the other end.
 *
 * And its caller opened the "more settings" panel for `lyrics`, with a comment
 * explaining that the lyrics field is unmounted while that panel is collapsed.
 * It is not, any more: the lyrics came out of the drawer in b8f26b3. The field
 * still in there is the title, and nothing opened the panel for it — so the
 * focus would have landed on an element that is not rendered.
 */
describe('which field a refusal sends the writer to', () => {
  const blockedAt = (field?: string) =>
    new ApiError('PROMPT_BLOCKED', 'blocked', 422, field ? { field } : {});

  it('sends a refused title to the title box', () => {
    expect(focusFieldFor(blockedAt('title'), false)).toBe('title');
    expect(focusFieldFor(blockedAt('title'), true)).toBe('title');
  });

  it('still routes the fields it already knew', () => {
    expect(focusFieldFor(blockedAt('lyrics'), false)).toBe('lyrics');
    expect(focusFieldFor(blockedAt('prompt'), false)).toBe('prompt');
    // While editing an existing song the description is called "instructions".
    expect(focusFieldFor(blockedAt('prompt'), true)).toBe('instructions');
  });

  it('falls back to the box in view when an older API names nothing', () => {
    expect(focusFieldFor(blockedAt(), false)).toBe('prompt');
    expect(focusFieldFor(blockedAt(), true)).toBe('instructions');
  });

  it('says nothing for failures that are not about a field', () => {
    expect(focusFieldFor(new ApiError('INTERNAL_ERROR', 'boom', 500), false)).toBe(null);
    expect(focusFieldFor(new Error('offline'), false)).toBe(null);
  });

  it('names the one field that is inside the collapsed panel', () => {
    // The caller opens "more settings" for exactly these. If the title ever
    // moves out of the drawer, or another field moves in, this is the list to
    // change — and the test fails rather than the focus silently missing.
    expect(FIELDS_IN_MORE_PANEL).toEqual(['title']);
  });
});
