# Veo 3.1 Fast through TokenStars — what the documentation says

> 2026-11-26. Read from TokenStars' public docs for the product owner, who is weighing Veo against the
> self-hosted LTX on dgxv (the Spark is slow: one clip at a time, cooling pauses, 512×768). Shared with
> Codex, who is redesigning the AI scene MV around it (docs/agents/CODEX_SCENE_MV_UI.md will follow).
> **Nothing here has been called yet.** Every line is what the page says, with its source.

Source: <https://docs.tokenstars.ai/en/docs/api/ai-model/videos/veo31> (the English page; the Japanese one
is incomplete). Auth: <https://docs.tokenstars.ai/ja/docs/guide/quick-start>.

## Calling it

| | |
| --- | --- |
| Auth | `Authorization: Bearer sk-…` — the same TokenStars key YUHA already uses for text, if that token's model allowlist includes Veo (403 otherwise) |
| Submit | `POST https://www.tokenstars.ai/v1/video/generations` → `{task_id, status: "queued", …}` |
| Poll | `GET /v1/video/generations/{task_id}` → `data.status` ∈ `queued · processing · succeeded · failed`; `data.url` when succeeded; `data.error` when failed (e.g. `SafetyFilterActivated: prompt violates content policy`) |
| Download | `data.url` (`…/v1/videos/{task_id}/content`), a signed link **valid 24 hours** |
| Model | `veo-3.1-fast-generate-001` |
| `duration` | 4 / 6 / 8 s (default 8) |
| `aspect_ratio` | `16:9` / **`9:16`** |
| `size` | `720p` / `1080p` (4K: standard model only) |
| `generate_audio` | default **false** — YUHA keeps it false: the MV uses the song's own sound |
| Also | `negative_prompt`, `seed`, `images` (image-to-video), `lastFrameImage` |
| Errors | 400 bad parameters · 401 bad key · 402 insufficient balance · 403 model not allowed for this key |
| Speed (their measurement, 8 s clip) | Fast ~75–105 s · Lite ~50–80 s · standard ~90–130 s |
| Polling | every 10–15 s (minimum 5 s) |
| Failed tasks | quota refunded automatically |
| Rate / concurrency limits | not stated |

## Price (USD per second of video, no audio)

| Model | 720p | 1080p |
| --- | --- | --- |
| veo-3.1-lite-generate-001 | $0.03 | $0.05 |
| **veo-3.1-fast-generate-001** | **$0.08** | $0.10 |
| veo-3.1-generate-001 | $0.20 | $0.20 |

With audio: Fast $0.10 / $0.12. These match Google's own Vertex AI list prices, so TokenStars shows no markup
on this page. The page writes "$" without naming the currency, and its quota example is internally
inconsistent; check the first real invoice.

**A 30-second vertical MV** (4 × 8 s, 32 s billed, 720p, no audio): Fast **$2.56**, Lite **$0.96**,
standard $6.40. The composed MV is 720×1280, so 720p is enough.

## Not stated anywhere readable — to ask TokenStars

The privacy policy and terms (`www.tokenstars.ai/privacy-policy`, `/user-agreement`) are JavaScript shells
with no readable text.

1. How long prompts and generated videos are kept by TokenStars and by Google, and whether either uses them
   for training.
2. The upstream route and region (Vertex AI, which region). For text, TokenStars fronts Azure OpenAI in
   Japan East (`packages/providers/src/text/tokenstars.ts`); for video this is unknown.
3. Rate and concurrency limits for video.

The privacy draft (docs/legal/PRIVACY_CHANGES_SCENE_MV.md) currently describes our own video server; with Veo
it must say the shot descriptions go to TokenStars and Google, and only what their published terms state
can be repeated there.
