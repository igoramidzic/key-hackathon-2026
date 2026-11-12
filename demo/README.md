# Demo briefing

A five-minute narrated, self-playing presentation of the project ("Operation NightWatch").

| File | What it is | Edit it? |
| --- | --- | --- |
| `content.yaml` | Every spoken line, on-screen word, number and timing | **Yes, this is the one** |
| `build.py` | Turns `content.yaml` into the voice-over and the page | No |
| `render.py` | Turns the page into `briefing.mp4` | No |
| `briefing.html` | The page (layout and styling; its content is filled in by the build) | Only for layout or colours |
| `narration.mp4` | Voice-over audio, generated | No |
| `briefing.mp4` | The video, generated | No |
| `record_live.py` | Records a real run of the guided demo (`/demo`) with a cursor | No |
| `live/run.mp4`, `live/run.json` | That recording, full length, and when each step started | No, re-record |
| `live.mp4` | The recording cut to fit the narration, generated | No |

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

## The live case is a real recording

The "Live case" chapter is not drawn: it plays a recording of the guided demo page working a real
scenario, with the actual Logs, Moogsoft, ServiceNow, GitLab and Teams screens and a cursor that
clicks Start and Merge. To record a new run (about three minutes; it resets the simulated bank):

```bash
pnpm dev                      # terminal 1: the simulated bank
pnpm demo --no-open           # terminal 2: the incident agent
uv run demo/record_live.py    # terminal 3: records demo/live/run.mp4 and run.json
```

Then rebuild. `content.yaml` (`demo` > `screen` > `live` > `cuts`) says which step of the recording
plays under which narration line; the build speeds each part up to fit. The numbers spoken in that
chapter (seven applications, eight people, fifty-six seconds, 2:21) come from that run's own recap
screen, so check them against the new recording and change the narration if they moved.

## Things worth knowing

- **Numbers that are spoken and shown** (the four resolve times, "under three minutes", "four hundred
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
