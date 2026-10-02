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
import { nextLineKey, PROMPT_HINT_KEYS } from '../apps/web/src/lib/messages.js';

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
