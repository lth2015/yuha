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

# Keep this grammar in step with packages/contracts/src/sections.ts.
# Parentheses also carry backing vocals; only known section names are metadata.
SQUARE_RE = re.compile(r"^\s*\[\s*([^\]]{1,40}?)\s*\]\s*$")
PAREN_RE = re.compile(r"^\s*\(\s*([^)]{1,40}?)\s*\)\s*$")
SECTION_NAMES = re.compile(
    r"^(intro|前奏|序奏|イントロ|pre[\s-]?chorus|预副歌|預副歌|bメロ|"
    r"chorus|hook|refrain|副歌|高潮|高潮部分|サビ|verse|主歌|詩|バース|aメロ|"
    r"bridge|桥段|橋段|过渡|過渡|ブリッジ|cメロ|rap|说唱|說唱|饶舌|饒舌|ラップ|"
    r"interlude|间奏|間奏|中间节奏|中間節奏|instrumental|inst|纯音乐|純音樂|演奏|"
    r"solo|独奏|獨奏|ソロ|outro|ending|尾奏|结尾|結尾|アウトロ)$", re.IGNORECASE,
)


# Longest silence between two characters of one sung line; anything longer is a
# match that belongs somewhere else.
MAX_HELD_GAP = 4.0


def section_name(line: str) -> Optional[str]:
    square = SQUARE_RE.match(line)
    if square:
        return square.group(1)
    paren = PAREN_RE.match(line)
    if paren:
        name = re.sub(r"[\s_-]*\d+$", "", paren.group(1)).strip()
        if SECTION_NAMES.fullmatch(name):
            return paren.group(1)
    return None


def parse_lyrics(lyrics: str) -> List[Tuple[str, str]]:
    """[(section, line_text)] for every singable line; section tags are not lines."""
    out: List[Tuple[str, str]] = []
    section = ""
    for raw in lyrics.splitlines():
        line = raw.strip()
        if not line:
            continue
        marker = section_name(line)
        if marker is not None:
            section = marker.strip()
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
    lyrics = "\n".join(text for _, text in parse_lyrics(lyrics))
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


def voiced_intervals(
    env_db: Sequence[float],
    hop: float,
    below_peak_db: float = 30.0,
    floor_db: float = -60.0,
    min_gap: float = 0.3,
    min_len: float = 0.15,
) -> List[Tuple[float, float]]:
    """Where the vocal stem is singing, from its loudness envelope (dBFS per hop).

    The threshold is relative to the stem's own loud passages, because a
    separated vocal's level depends on the mix; gaps shorter than a breath are
    bridged so one phrase is one interval.
    """
    if not env_db:
        return []
    ranked = sorted(env_db)
    peak = ranked[min(len(ranked) - 1, int(len(ranked) * 0.95))]
    threshold = max(floor_db, peak - below_peak_db)
    out: List[Tuple[float, float]] = []
    start: Optional[int] = None
    for i, db in enumerate(list(env_db) + [float("-inf")]):
        if db >= threshold and start is None:
            start = i
        elif db < threshold and start is not None:
            s, e = start * hop, i * hop
            if out and s - out[-1][1] < min_gap:
                out[-1] = (out[-1][0], e)
            else:
                out.append((s, e))
            start = None
    return [(round(s, 3), round(e, 3)) for s, e in out if e - s >= min_len]


def _voiced_at(voiced: Sequence[Tuple[float, float]], t: float) -> bool:
    return any(s <= t < e for s, e in voiced)


def align_lines(
    lyrics: str,
    words: Sequence[Tuple[str, float, float]],
    duration: float,
    min_line: float = 0.6,
    voiced: Optional[Sequence[Tuple[float, float]]] = None,
) -> Dict:
    """Return {"lines": [{text, section, start, end, words:[{w,start,end}]}], "coverage": 0..1}.

    `voiced`, when given, is where the separated vocal is actually singing
    (see voiced_intervals); it corrects the two ways Whisper's word clock
    smears across an instrumental gap. Without it the timings are Whisper's.
    """
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
    char_run: Dict[int, int] = {}
    if lyr_chars and t_chars:
        sm = difflib.SequenceMatcher(None, lyr_chars, t_chars, autojunk=False)
        for a, b, size in sm.get_matching_blocks():
            for k in range(size):
                char_time[a + k] = (t_start[b + k], t_end[b + k])
                char_run[a + k] = size
    coverage = len(char_time) / max(1, len(lyr_chars))

    # Which matches a line's timing may rest on. A lone matched character is
    # usually a common one (我, 的, a, e) found inside somebody else's mumble:
    # difflib keeps matches in order, but not near, so one stray 我 seconds
    # early made its line light up seconds before it was sung. Runs of two or
    # more are evidence; a lone match counts only when the line has nothing
    # better. Then a matched character separated from the rest of its line by
    # longer than any held note is dropped from either edge, for the same
    # reason.
    n = len(parsed)
    by_line: Dict[int, List[int]] = {}
    for idx in char_time:
        by_line.setdefault(lyr_owner[idx][0], []).append(idx)
    trusted: Dict[int, List[int]] = {}
    for li, idxs in by_line.items():
        runs = [i for i in idxs if char_run[i] >= 2]
        keep = sorted(runs or idxs, key=lambda i: char_time[i][0])
        while len(keep) > 1 and char_time[keep[1]][0] - char_time[keep[0]][1] > MAX_HELD_GAP:
            keep.pop(0)
        while len(keep) > 1 and char_time[keep[-1]][0] - char_time[keep[-2]][1] > MAX_HELD_GAP:
            keep.pop()
        trusted[li] = keep

    # Line spans from the characters that matched.
    spans: List[Optional[Tuple[float, float]]] = [None] * n
    for li, idxs in trusted.items():
        spans[li] = (min(char_time[i][0] for i in idxs), max(char_time[i][1] for i in idxs))

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

    # Whisper's word clock smears across silence: the first word after an
    # interlude is stretched back into it, and the last word before one is
    # stretched forward. Where the separated vocal says nobody is singing,
    # believe it — a start moves to where the voice comes back, an end to
    # where it stopped. Bounded by what Whisper did hear: a start never moves
    # past the end of the line's first trusted character, nor onto the next
    # line.
    if voiced:
        for i in range(n):
            s, e = spans[i]  # type: ignore[misc]
            if not _voiced_at(voiced, s):
                limit = e
                if trusted.get(i):
                    limit = min(limit, min(char_time[k][1] for k in trusted[i]))
                if i + 1 < n:
                    limit = min(limit, spans[i + 1][0])  # type: ignore[index]
                onset = min((vs for vs, _ in voiced if vs > s), default=None)
                if onset is not None and onset < limit:
                    s = onset
            if not _voiced_at(voiced, e - 0.001):
                stop = max((ve for _, ve in voiced if s < ve <= e), default=None)
                if stop is not None:
                    e = min(e, stop + 0.15)
            spans[i] = (s, max(e, s))

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
    for idxs in trusted.values():
        for idx in idxs:
            li, ci = lyr_owner[idx]
            s, e = char_time[idx]
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
