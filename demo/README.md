# Demo briefing

A 4½-minute narrated, self-playing presentation of the project ("Operation Nightwatch").

| File | What it is | Edit it? |
| --- | --- | --- |
| `content.yaml` | Every spoken line, on-screen word, number and timing | **Yes, this is the one** |
| `build.py` | Turns `content.yaml` into the voice-over and the page | No |
| `render.py` | Turns the page into `briefing.mp4` | No |
| `briefing.html` | The page (layout and styling; its content is filled in by the build) | Only for layout or colours |
| `narration.mp4` | Voice-over audio, generated | No |
| `briefing.mp4` | The video, generated | No |

## Change something

1. Edit `content.yaml`. The comments at the top explain the format.
2. Rebuild the page and the voice-over (a few seconds if only on-screen text changed, longer if
   narration changed, because those lines are spoken again):

   ```bash
   uv run --python 3.12 demo/build.py
   ```

3. Open `demo/briefing.html` in a browser and press **Start briefing**.
4. When you are happy, render the video too (about two and a half minutes):

   ```bash
   uv run --python 3.12 demo/build.py --video
   ```

The build prints the total running time and warns if it goes over five minutes, or if a timing
points at a narration line that does not exist.

## Things worth knowing

- **Numbers that are spoken and shown** (the four metrics, "under three minutes", "four hundred
  applications") are in two places: the `narration` line and the `screen` block. They are marked
  `<- spoken too` in `content.yaml`. Change both.
- **Timing follows the voice.** Each on-screen item has `at: <beat>`, so rewriting a narration
  line moves its visuals automatically. Nothing is timed in seconds by hand.
- **Lists can grow or shrink**: steps, metrics, tiles, pipeline boxes, phases, missions, channel
  members, child incidents. The layout was sized for the current counts, so check the result
  after adding more than one or two.
- **A more human voice**: set `voice_engine: elevenlabs` in `content.yaml`, create an API key at
  elevenlabs.io, and run `export ELEVENLABS_API_KEY=...` before the build. The narration text is
  sent to ElevenLabs. Pick a voice by pasting its ID into `elevenlabs.voice_id`.
- **A different local voice**: set `voice:` (any Kokoro voice, e.g. `bf_emma`, `am_michael`,
  `af_heart`) and `speed:`. The first build with a new voice re-speaks every line.
- **Captions** in the video are the `narration` text. Use `{text: ..., say: ...}` when the voice
  needs a phonetic spelling.
- **Layout, colours, fonts** are in the `<style>` block at the top of `briefing.html`; the colour
  palette is the list of `--name` values in `:root`.

The published copy on claude.ai does not update by itself. Ask Claude to republish
`demo/briefing.html` after a rebuild.
