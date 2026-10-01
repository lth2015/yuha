"""
Lyric ↔ vocal alignment for YUHA's synced lyrics.

ACE-Step does not report when it sings each line, so the timing has to be
recovered from the audio: Whisper transcribes the rendered song with word
timestamps, and the *known* lyrics are then aligned onto that transcript at the
character level. The transcript is never shown — it is only a clock. Lines the
recogniser missed are placed proportionally between their aligned neighbours,
so every line still gets a start and an end, in order.

Pure functions here (no torch) so the matching can be tested on its own.
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from typing import Dict, List, Optional, Sequence, Tuple

SECTION_RE = re.compile(r"^\s*[\[(（【]\s*([^\])）】]+?)\s*[\])）】]\s*$")


def parse_lyrics(lyrics: str) -> List[Tuple[str, str]]:
    """[(section, line_text)] for every singable line; section tags are not lines."""
    out: List[Tuple[str, str]] = []
    section = ""
    for raw in lyrics.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = SECTION_RE.match(line)
        if m:
            section = m.group(1).strip()
            continue
        out.append((section, line))
    return out


def norm_char(ch: str) -> str:
    """Comparable form of one character: NFKC, lower-case, punctuation/space dropped."""
    c = unicodedata.normalize("NFKC", ch).lower()
    if not c or unicodedata.category(c[0])[0] in ("P", "Z", "S", "C"):
        return ""
    # Katakana and hiragana sing the same; compare as hiragana.
    o = ord(c[0])
    if 0x30A1 <= o <= 0x30F6:
        c = chr(o - 0x60)
    return c


def guess_language(lyrics: str) -> Optional[str]:
    if re.search(r"[぀-ヿ]", lyrics):
        return "ja"
    if re.search(r"[가-힯]", lyrics):
        return "ko"
    if re.search(r"[一-鿿]", lyrics):
        return "zh"
    if re.search(r"[a-zA-Z]", lyrics):
        return "en"
    return None


def _transcript_chars(words: Sequence[Tuple[str, float, float]]) -> Tuple[List[str], List[float], List[float]]:
    """Explode recognised words into characters, spreading each word's span over its characters."""
    chars: List[str] = []
    starts: List[float] = []
    ends: List[float] = []
    for text, s, e in words:
        cs = [c for c in (norm_char(ch) for ch in text) if c]
        if not cs:
            continue
        step = max(0.0, e - s) / len(cs)
        for i, c in enumerate(cs):
            chars.append(c)
            starts.append(s + step * i)
            ends.append(s + step * (i + 1))
    return chars, starts, ends


def align_lines(
    lyrics: str,
    words: Sequence[Tuple[str, float, float]],
    duration: float,
    min_line: float = 0.6,
) -> Dict:
    """Return {"lines": [{text, section, start, end, words:[{w,start,end}]}], "coverage": 0..1}."""
    parsed = parse_lyrics(lyrics)
    if not parsed:
        return {"lines": [], "coverage": 0.0}

    # Lyric side: one entry per comparable character, remembering its line and
    # its position in the displayed text.
    lyr_chars: List[str] = []
    lyr_owner: List[Tuple[int, int]] = []  # (line index, char index in display text)
    for li, (_, text) in enumerate(parsed):
        for ci, ch in enumerate(text):
            c = norm_char(ch)
            if c:
                lyr_chars.append(c)
                lyr_owner.append((li, ci))

    t_chars, t_start, t_end = _transcript_chars(words)
    char_time: Dict[int, Tuple[float, float]] = {}
    if lyr_chars and t_chars:
        sm = difflib.SequenceMatcher(None, lyr_chars, t_chars, autojunk=False)
        for a, b, size in sm.get_matching_blocks():
            for k in range(size):
                char_time[a + k] = (t_start[b + k], t_end[b + k])
    coverage = len(char_time) / max(1, len(lyr_chars))

    # Line spans from the characters that matched.
    n = len(parsed)
    spans: List[Optional[Tuple[float, float]]] = [None] * n
    for idx, (s, e) in char_time.items():
        li = lyr_owner[idx][0]
        cur = spans[li]
        spans[li] = (s, e) if cur is None else (min(cur[0], s), max(cur[1], e))

    # A recogniser can match a stray character far away; drop spans that break
    # the order of their neighbours, then fill the holes proportionally.
    last_end = 0.0
    for i in range(n):
        sp = spans[i]
        if sp is None:
            continue
        if sp[0] < last_end - 0.25:
            spans[i] = None
            continue
        last_end = sp[1]

    weights = [max(1, sum(1 for ch in t if norm_char(ch))) for _, t in parsed]
    i = 0
    while i < n:
        if spans[i] is not None:
            i += 1
            continue
        j = i
        while j < n and spans[j] is None:
            j += 1
        left = spans[i - 1][1] if i > 0 and spans[i - 1] else 0.0
        right = spans[j][0] if j < n and spans[j] else duration
        if right <= left:
            right = min(duration, left + min_line * (j - i))
        total = sum(weights[i:j])
        t = left
        for k in range(i, j):
            span = (right - left) * weights[k] / total
            spans[k] = (t, t + span)
            t += span
        i = j

    # Each line holds until the next one starts (short gaps), so the karaoke
    # line does not blink off between breaths.
    lines = []
    for i, (section, text) in enumerate(parsed):
        s, e = spans[i]  # type: ignore[misc]
        nxt = spans[i + 1][0] if i + 1 < n else duration  # type: ignore[index]
        if 0 < nxt - e < 1.5:
            e = nxt
        e = max(e, s + min_line)
        lines.append({"text": text, "section": section, "start": round(s, 3), "end": round(min(e, duration), 3)})

    # Per-character "words" for the karaoke fill: matched characters carry
    # their own time, the rest are interpolated inside the line.
    per_line_marks: Dict[int, List[Tuple[int, float, float]]] = {}
    for idx, (s, e) in char_time.items():
        li, ci = lyr_owner[idx]
        per_line_marks.setdefault(li, []).append((ci, s, e))
    for li, line in enumerate(lines):
        text = line["text"]
        marks = {ci: (s, e) for ci, s, e in per_line_marks.get(li, [])
                 if line["start"] - 0.5 <= s <= line["end"] + 0.5}
        idxs = list(range(len(text)))
        known = sorted(marks)
        out = []
        for ci in idxs:
            if ci in marks:
                s, e = marks[ci]
            else:
                prev = max((k for k in known if k < ci), default=None)
                nxt = min((k for k in known if k > ci), default=None)
                a_t, a_i = (marks[prev][1], prev) if prev is not None else (line["start"], -1)
                b_t, b_i = (marks[nxt][0], nxt) if nxt is not None else (line["end"], len(text))
                frac = (ci - a_i) / max(1, b_i - a_i)
                s = a_t + (b_t - a_t) * frac
                e = s + max(0.05, (b_t - a_t) / max(1, b_i - a_i))
            out.append({"w": text[ci], "start": round(max(line["start"], s), 3), "end": round(min(line["end"], max(s, e)), 3)})
        line["words"] = out
    return {"lines": lines, "coverage": round(coverage, 3)}
