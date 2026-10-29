"""
Forced alignment: the known lyrics, placed onto the separated vocal.

Whisper was asked to *transcribe* the vocal and its word clock was matched
back onto the lyrics (align.py). That is two guesses stacked: what was sung,
then when — and a sung word Whisper did not recognise had no time at all, so
whole lines were spread by character count between their neighbours, and a
song whose transcript covered less than ALIGN_MIN_COVERAGE was given up on
entirely and shown as 「估算同步」. Japanese with loanwords and acronyms
(「1円は1JPYC」) is exactly what a recogniser misses.

We never needed the transcript: we wrote the lyrics. A CTC acoustic model
(torchaudio's MMS_FA, trained for forced alignment over 1,100+ languages)
answers the only question that matters — where in the audio each known unit
is sung — by Viterbi over its frame posteriors. Every unit gets a time, in
order, by construction. How sure it is comes from the same posteriors.

The model reads romanised text (a-z and '), so each line is cut into units
that carry their own romanisation: a word for Japanese (fugashi + cutlet,
already in the image for ACE-Step), a character for Chinese (pypinyin), a
syllable block for Korean, a word for Latin script. Digits are read as number
words and acronyms as letter names (`spoken`). Anything still without letters
becomes the star token, which matches any sound, so it takes up its time
without claiming to know what was sung. A star also sits between lines, to absorb
breaths and ad-libs that are not in the lyrics.

Pure-python pieces (units, grouping, the result shape) are separate from the
torch call so they can be tested without a GPU.
"""
from __future__ import annotations

import logging
import re
import threading
import unicodedata
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from align import guess_language, norm_char, parse_lyrics

log = logging.getLogger("yuha-music")

STAR = "*"
# Frame posteriors below this, averaged over a unit's letters, mean the model
# did not find that unit where Viterbi was forced to put it.
UNIT_MIN_SCORE = 0.05


@dataclass
class Unit:
    line: int
    # Character offsets [start, end) of this unit in the displayed line.
    first: int
    last: int
    # Romanised letters, or STAR.
    letters: str


# ---------------------------------------------------------------- romanising

_ja = None
_ja_lock = threading.Lock()


def _japanese():
    """(tagger, cutlet) or None. Loaded once; both ship in the image for ACE-Step."""
    global _ja
    with _ja_lock:
        if _ja is None:
            try:
                import cutlet
                import fugashi
                # Native spelling: チェーン is sung che-e-n, not "chain".
                _ja = (fugashi.Tagger(), cutlet.Cutlet(use_foreign_spelling=False))
            except Exception:  # pragma: no cover - depends on the image
                log.exception("Japanese romanisation unavailable")
                _ja = False
    return _ja or None


def clean_letters(s: str) -> str:
    """Only what the model has labels for: lower-case a-z and the apostrophe."""
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if "a" <= c <= "z" or c == "'")


def _is_acronym(word: str) -> bool:
    return len(word) >= 2 and word.isascii() and word.isalpha() and word.isupper()


# Letter names as a singer says them. A first version made acronyms and
# digits star tokens, and on a real song the star swallowed the line around
# them: 「いま JPYCで送れるよ」 was left 0.8 s for twelve characters, because a
# star matches any sound and the star took the "JPYC" and most of what
# followed. Said aloud, they are ordinary units.
_LETTERS_JA = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (
    "ei bii shii dii ii efu jii eichi ai jei kei eru emu enu oo pii kyuu aaru esu tii yuu bui "
    "daburyuu ekkusu wai zetto").split()))
_LETTERS_EN = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (
    "ay bee see dee ee ef jee aitch eye jay kay el em en oh pee cue ar ess tee you vee "
    "doubleyou ex why zee").split()))
_ZH_DIGITS = "ling yi er san si wu liu qi ba jiu".split()


def _zh_number(n: int) -> str:
    if n < 10:
        return _ZH_DIGITS[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return ("" if tens == 1 else _ZH_DIGITS[tens]) + "shi" + (_ZH_DIGITS[ones] if ones else "")
    # Years and longer numbers are read digit by digit (二零二六).
    return "".join(_ZH_DIGITS[int(d)] for d in str(n))


def spoken(word: str, lang: Optional[str]) -> str:
    """Letters for a digit run or an acronym as it is sung; '' if unknown."""
    if word.isdigit():
        n = int(word)
        if lang == "zh":
            return _zh_number(n)
        try:
            from num2words import num2words
            if lang == "ja":
                ja = _japanese()
                return clean_letters(ja[1].romaji(num2words(n, lang="ja"))) if ja else ""
            return clean_letters(num2words(n, lang="ko" if lang == "ko" else "en"))
        except Exception:
            return ""
    if _is_acronym(word):
        names = _LETTERS_JA if lang == "ja" else _LETTERS_EN
        return "".join(names.get(c, "") for c in word)
    return ""


def _latin_units(li: int, text: str, start: int, end: int, out: List[Unit],
                 lang: Optional[str] = None) -> None:
    for m in re.finditer(r"[A-Za-z']+|\d+", text[start:end]):
        word = m.group(0)
        a, b = start + m.start(), start + m.end()
        if word.isdigit() or _is_acronym(word):
            letters = spoken(word, lang)
        else:
            letters = clean_letters(word)
        out.append(Unit(li, a, b, letters or STAR))


def line_units(li: int, text: str, lang: Optional[str],
               romanise_ja: Optional[Callable[[str], List[Tuple[str, str]]]] = None) -> List[Unit]:
    """Cut one displayed line into units, each carrying its offsets and letters."""
    out: List[Unit] = []
    if lang == "ja":
        pieces = romanise_ja(text) if romanise_ja else []
        if pieces:
            pos = 0
            for surface, roman in pieces:
                at = text.find(surface, pos)
                if at < 0:
                    continue
                pos = at + len(surface)
                if not any(norm_char(c) for c in surface):
                    continue  # punctuation and spaces are not sung
                if re.fullmatch(r"[A-Za-z0-9']+", surface):
                    _latin_units(li, text, at, pos, out, lang)
                    continue
                out.append(Unit(li, at, pos, clean_letters(roman) or STAR))
            return out
        # Without a Japanese tokenizer kana and kanji have no letters; let the
        # star carry them so the line is still placed.
    if lang == "zh":
        try:
            from pypinyin import Style, pinyin
        except Exception:  # pragma: no cover - depends on the image
            pinyin = None
        i = 0
        while i < len(text):
            ch = text[i]
            if re.match(r"[A-Za-z0-9']", ch):
                j = i
                while j < len(text) and re.match(r"[A-Za-z0-9']", text[j]):
                    j += 1
                _latin_units(li, text, i, j, out, lang)
                i = j
                continue
            if norm_char(ch):
                letters = clean_letters(pinyin(ch, style=Style.NORMAL)[0][0]) if pinyin else ""
                out.append(Unit(li, i, i + 1, letters or STAR))
            i += 1
        return out
    if lang == "ko":
        try:
            from hangul_romanize import Transliter
            from hangul_romanize.rule import academic
            tr = Transliter(academic)
        except Exception:  # pragma: no cover - depends on the image
            tr = None
        for m in re.finditer(r"\S+", text):
            word = m.group(0)
            if re.fullmatch(r"[A-Za-z0-9']+", word):
                _latin_units(li, text, m.start(), m.end(), out, lang)
                continue
            if any(norm_char(c) for c in word):
                letters = clean_letters(tr.translit(word)) if tr else ""
                out.append(Unit(li, m.start(), m.end(), letters or STAR))
        return out
    # Latin script, and anything else: words; a word with no letters is a star.
    for m in re.finditer(r"\S+", text):
        word = m.group(0)
        if not any(norm_char(c) for c in word):
            continue
        if re.fullmatch(r"[A-Za-z0-9'.,!?;:\-]+", word):
            core = word.strip(".,!?;:-")
            letters = spoken(core, lang) if core.isdigit() or _is_acronym(core) else clean_letters(core)
        else:
            letters = clean_letters(word)
        out.append(Unit(li, m.start(), m.end(), letters or STAR))
    return out


def romanise_ja_default(text: str) -> List[Tuple[str, str]]:
    ja = _japanese()
    if not ja:
        return []
    tagger, katsu = ja
    return [(w.surface, katsu.romaji(w.surface)) for w in tagger(text)]


def lyric_units(lyrics: str, lang: Optional[str] = None,
                romanise_ja: Optional[Callable[[str], List[Tuple[str, str]]]] = None
                ) -> Tuple[List[Tuple[str, str]], List[Unit]]:
    parsed = parse_lyrics(lyrics)
    lang = lang if lang is not None else guess_language(lyrics)
    if lang == "ja" and romanise_ja is None:
        romanise_ja = romanise_ja_default
    units: List[Unit] = []
    for li, (_, text) in enumerate(parsed):
        units.extend(line_units(li, text, lang, romanise_ja))
    return parsed, units


# ------------------------------------------------------- tokens and results

def token_plan(units: Sequence[Unit], dictionary: Dict[str, int]) -> Tuple[List[int], List[Tuple[int, int]]]:
    """Target token ids, and for each unit the [start, end) slice of them it owns.

    A star sits before every line (it absorbs a breath, an ad-lib, the end of
    an interlude); a unit whose letters the dictionary lacks becomes a star.
    The leading star of a line belongs to no unit.
    """
    tokens: List[int] = []
    owned: List[Tuple[int, int]] = []
    star = dictionary[STAR]
    prev_line = None
    for u in units:
        if u.line != prev_line:
            tokens.append(star)
            prev_line = u.line
        a = len(tokens)
        if u.letters == STAR or any(c not in dictionary for c in u.letters):
            tokens.append(star)
        else:
            tokens.extend(dictionary[c] for c in u.letters)
        owned.append((a, len(tokens)))
    tokens.append(star)
    return tokens, owned


def build_result(parsed: Sequence[Tuple[str, str]], units: Sequence[Unit],
                 unit_spans: Sequence[Tuple[float, float, float]], duration: float,
                 min_line: float = 0.6) -> Dict:
    """Lines and per-character words from unit (start, end, score) triples.

    `coverage` keeps its meaning for the caller — how much of the lyrics was
    actually found — as the share of lettered units the model placed with
    some confidence. Star units are not evidence either way and are left out.
    """
    n = len(parsed)
    by_line: Dict[int, List[int]] = {}
    for k, u in enumerate(units):
        by_line.setdefault(u.line, []).append(k)

    lettered = [k for k, u in enumerate(units) if u.letters != STAR]
    found = [k for k in lettered if unit_spans[k][2] >= UNIT_MIN_SCORE]
    coverage = len(found) / max(1, len(lettered))

    spans: List[Optional[Tuple[float, float]]] = [None] * n
    for li, ks in by_line.items():
        spans[li] = (unit_spans[ks[0]][0], unit_spans[ks[-1]][1])
    # A line with nothing singable (only punctuation) has no units; give it
    # the gap it sits in.
    for i in range(n):
        if spans[i] is None:
            left = next((spans[j][1] for j in range(i - 1, -1, -1) if spans[j]), 0.0)
            right = next((spans[j][0] for j in range(i + 1, n) if spans[j]), duration)
            spans[i] = (left, max(left, right))

    lines = []
    for i, (section, text) in enumerate(parsed):
        s, e = spans[i]  # type: ignore[misc]
        nxt = spans[i + 1][0] if i + 1 < n else duration  # type: ignore[index]
        if 0 < nxt - e < 1.5:
            e = nxt  # hold through a breath so the line does not blink off
        e = max(e, s + min_line)
        lines.append({"text": text, "section": section, "start": round(s, 3), "end": round(min(e, duration), 3)})

    for li, line in enumerate(lines):
        text = line["text"]
        marks: Dict[int, Tuple[float, float]] = {}
        for k in by_line.get(li, []):
            u = units[k]
            s, e, _ = unit_spans[k]
            width = max(1, u.last - u.first)
            step = (e - s) / width
            for c in range(u.first, u.last):
                marks[c] = (s + step * (c - u.first), s + step * (c - u.first + 1))
        out = []
        last_t = line["start"]
        for ci, ch in enumerate(text):
            if ci in marks:
                s, e = marks[ci]
                last_t = e
            else:
                s = e = last_t  # punctuation and spaces take no time
            out.append({"w": ch, "start": round(max(line["start"], s), 3),
                        "end": round(min(line["end"], max(s, e)), 3)})
        line["words"] = out
    return {"lines": lines, "coverage": round(coverage, 3)}


def group_spans(token_spans: Sequence[Tuple[int, int, float]], owned: Sequence[Tuple[int, int]],
                frame_seconds: float) -> List[Tuple[float, float, float]]:
    """Per-unit (start, end, mean score) from per-token (start_frame, end_frame, score)."""
    out = []
    for a, b in owned:
        ts = token_spans[a:b]
        s = ts[0][0] * frame_seconds
        e = ts[-1][1] * frame_seconds
        score = sum(t[2] for t in ts) / len(ts)
        out.append((s, e, score))
    return out


# ------------------------------------------------------------------ the model

_bundle_state: Dict[str, object] = {}
_model_lock = threading.Lock()

# wav2vec2's attention is global, so memory grows with the square of the
# input; a song is cut into windows and the emissions joined.
WINDOW_S = 20.0
CONTEXT_S = 1.0


def _model(device: str):
    with _model_lock:
        if "model" not in _bundle_state:
            import torchaudio
            bundle = torchaudio.pipelines.MMS_FA
            model = bundle.get_model(with_star=True).to(device).eval()
            _bundle_state.update(model=model, dictionary=bundle.get_dict(star=STAR),
                                 sample_rate=bundle.sample_rate, device=device)
    return _bundle_state


def emissions(wave16k, device: str):
    """Log-posteriors [frames, labels] for a 16 kHz mono float array."""
    import torch
    state = _model(device)
    model = state["model"]
    sr = int(state["sample_rate"])  # 16000
    x = torch.as_tensor(wave16k, dtype=torch.float32)
    win, ctx = int(WINDOW_S * sr), int(CONTEXT_S * sr)
    parts = []
    total = x.shape[0]
    with torch.inference_mode():
        for start in range(0, total, win):
            a = max(0, start - ctx)
            b = min(total, start + win + ctx)
            em, _ = model(x[a:b].unsqueeze(0).to(device))
            em = em[0].float().cpu()
            # Keep only the frames for [start, start + win).
            per = em.shape[0] / (b - a)
            lo = int(round((start - a) * per))
            hi = int(round((min(total, start + win) - a) * per))
            parts.append(em[lo:hi])
    em = torch.cat(parts, dim=0)
    return torch.log_softmax(em, dim=-1), total / sr


def force_align(lyrics: str, wave16k, duration: float, device: str = "cuda") -> Dict:
    """{"lines", "coverage"} for `lyrics` on a 16 kHz mono vocal."""
    import torch
    import torchaudio.functional as F
    parsed, units = lyric_units(lyrics)
    if not units:
        return {"lines": [], "coverage": 0.0}
    em, audio_s = emissions(wave16k, device)
    state = _model(device)
    tokens, owned = token_plan(units, state["dictionary"])  # type: ignore[arg-type]
    if len(tokens) * 2 >= em.shape[0]:
        raise ValueError("lyrics are too long for the audio to align")
    # forced_align's CPU kernel: the image builds torchaudio without CUDA.
    targets = torch.tensor([tokens], dtype=torch.int32)
    aligned, scores = F.forced_align(em.unsqueeze(0), targets, blank=0)
    merged = F.merge_tokens(aligned[0], scores[0].exp())
    token_spans = [(t.start, t.end, float(t.score)) for t in merged]
    if len(token_spans) != len(tokens):
        raise ValueError(f"alignment returned {len(token_spans)} spans for {len(tokens)} tokens")
    frame_s = audio_s / em.shape[0]
    return build_result(parsed, units, group_spans(token_spans, owned, frame_s), duration)
