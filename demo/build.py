# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "kokoro>=0.9.4",
#   "soundfile",
#   "numpy",
#   "pyyaml",
#   "pip",
#   "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
#   "playwright",
#   "imageio-ffmpeg",
# ]
# ///
"""Build the demo briefing from demo/content.yaml.

    uv run --python 3.12 demo/build.py            # voice-over + page
    uv run --python 3.12 demo/build.py --video    # ...and demo/briefing.mp4

Reads content.yaml, speaks every narration beat with the chosen voice engine (local Kokoro, or
ElevenLabs when `voice_engine: elevenlabs` and ELEVENLABS_API_KEY is set; only beats
whose text changed are re-synthesized), joins them into narration.mp4 (audio only), and writes the
beat timings and all on-screen content into briefing.html. The page draws itself from those two
blocks, so nothing in briefing.html needs editing by hand.

Needs macOS `afconvert` for the AAC encode.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf
import yaml

HERE = Path(__file__).parent
CACHE = HERE / ".cache"
RATE = 24000
SPEC = re.compile(r"^([a-z]+\d+)(\.e)?(?:@[\d.]+)?(?:[+-][\d.]+)?$")
LIMIT = 300  # seconds; the brief is "no longer than five minutes"

_pipeline = None


def eleven(text: str, cfg: dict) -> np.ndarray:
    """One beat from the ElevenLabs API as mono float32 at RATE (raw 24 kHz PCM, no decoding)."""
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit(
            "content.yaml asks for the ElevenLabs voice, but ELEVENLABS_API_KEY is not set.\n"
            "Create a key at elevenlabs.io (Developers > API keys) and put it in demo/.env as\n"
            "  ELEVENLABS_API_KEY=...   (that file is git-ignored), then build again.\n"
            "Or set `voice_engine: kokoro` to use the local voice."
        )
    settings = {k: float(v) for k, v in (cfg.get("settings") or {}).items()}
    body = {"text": text, "model_id": cfg.get("model", "eleven_v3")}
    if settings:
        body["voice_settings"] = settings
    request = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{cfg['voice_id']}?output_format=pcm_24000",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json", "User-Agent": "briefing-build"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            pcm = response.read()
    except urllib.error.HTTPError as err:
        sys.exit(f"ElevenLabs refused the request ({err.code}): {err.read().decode(errors='replace')[:600]}")
    return np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype("float32") / 32768.0


def tempo(path: Path, speed: float) -> np.ndarray:
    """Read a cached beat, sped up or slowed down without changing its pitch."""
    if abs(speed - 1.0) < 0.005:
        return sf.read(path, dtype="float32")[0]
    import imageio_ffmpeg

    out = path.with_name(f"{path.stem}.x{speed:.2f}p.wav")
    if not out.exists():
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(path),
             "-filter:a", f"apad=pad_dur=0.4,atempo={min(max(speed, 0.5), 2.0):.3f}", "-ar", str(RATE), str(out)],
            check=True,
        )  # fmt: skip
    return trim(sf.read(out, dtype="float32")[0])


def synth(text: str, voice: str, speed: float, engine: str = "kokoro", cfg: dict | None = None) -> np.ndarray:
    """One beat as mono float32 at RATE, cached on disk by engine, voice, settings and text."""
    # `speed` is applied after the fact for ElevenLabs, so it is not part of what gets cached.
    api_cfg = {k: v for k, v in (cfg or {}).items() if k != "speed"}
    ident = f"{voice}|{speed}|{text}" if engine == "kokoro" else f"11|{json.dumps(api_cfg, sort_keys=True)}|{text}"
    key = hashlib.sha1(ident.encode()).hexdigest()[:16]
    path = CACHE / f"{key}.wav"
    if engine == "elevenlabs":
        CACHE.mkdir(exist_ok=True)
        if not path.exists():
            sf.write(path, trim(eleven(text, api_cfg)), RATE)
        # The service sometimes returns a take that starts or stops mid-sound. Nothing can repair
        # that afterwards, so ask again (two extra takes at most, ever) and keep the cleanest.
        tries = path.with_suffix(".takes")
        used = int(tries.read_text()) if tries.exists() else 0
        best = sf.read(path, dtype="float32")[0]
        while roughness(best) > 0 and used < RETAKES:
            used += 1
            tries.write_text(str(used))
            take = trim(eleven(text, api_cfg))
            print(f"  retake {used}/{RETAKES} ({edges(best)} -> {edges(take)}): {text[:60]}")
            if roughness(take) < roughness(best):
                best = take
                sf.write(path, best, RATE)
                for old in CACHE.glob(f"{key}.x*.wav"):
                    old.unlink()
        if roughness(best) > 0:
            ROUGH.append(f"{edges(best)}  {text[:70]}")
        return tempo(path, float((cfg or {}).get("speed", 1.0)))
    if path.exists():
        return sf.read(path, dtype="float32")[0]
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline

        _pipeline = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
    chunks = [np.asarray(audio) for _, _, audio in _pipeline(text, voice=voice, speed=speed)]
    audio = trim(np.concatenate(chunks).astype("float32"))
    CACHE.mkdir(exist_ok=True)
    sf.write(path, audio, RATE)
    return audio


RETAKES = 2
ROUGH: list[str] = []  # lines whose best take still starts or ends abruptly
HEAD_DB, TAIL_DB = -30.0, -32.0  # louder than this in the first / last 30 ms means it was cut off


def level(audio: np.ndarray) -> float:
    return 20 * float(np.log10(max(float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0, 1e-6)))


def roughness(audio: np.ndarray) -> float:
    """How far (dB) the first and last 30 ms are above "quiet"; 0 for a take with clean edges."""
    n = int(0.03 * RATE)
    return max(level(audio[:n]) - HEAD_DB, 0.0) + max(level(audio[-n:]) - TAIL_DB, 0.0)


def edges(audio: np.ndarray) -> str:
    n = int(0.03 * RATE)
    return f"start {level(audio[:n]):.0f} dB, end {level(audio[-n:]):.0f} dB"


def soften(audio: np.ndarray, fade_in: float = 0.015, fade_out: float = 0.09) -> np.ndarray:
    """Ease each line in and out, so lines never meet the silence between them with a click."""
    out = audio.copy()
    a, b = min(int(fade_in * RATE), len(out) // 2), min(int(fade_out * RATE), len(out) // 2)
    if a:
        out[:a] *= np.linspace(0.0, 1.0, a, dtype="float32") ** 2
    if b:
        out[-b:] *= np.cos(np.linspace(0.0, np.pi / 2, b, dtype="float32")) ** 2
    return out


def trim(audio: np.ndarray, threshold: float = 0.004, pad: float = 0.09) -> np.ndarray:
    """Cut leading and trailing silence so the gaps between beats are ours to set."""
    loud = np.flatnonzero(np.abs(audio) > threshold)
    if not loud.size:
        return audio
    keep = int(pad * RATE)
    return audio[max(loud[0] - keep, 0) : loud[-1] + keep]


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * RATE), dtype="float32")


def timing_refs(node, path=""):
    """Yield (where, spec) for every value in the screen content that names a narration beat."""
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else key
            if isinstance(value, str) and (key == "at" or key.endswith("_at")):
                yield here, value
            elif key in ("beats", "spread") and isinstance(value, list):
                yield from ((here, v) for v in value)
            elif key == "clock" and isinstance(value, list):
                yield from ((here, row[0]) for row in value if isinstance(row, list) and row)
            else:
                yield from timing_refs(value, here)
    elif isinstance(node, list):
        for n, value in enumerate(node):
            yield from timing_refs(value, f"{path}[{n}]")


def when(spec: str, beats: dict) -> float:
    """Seconds for a timing such as p2, p2.e, p2@0.5 or p2+1.5 (the same rules the page uses)."""
    m = re.match(r"^([a-z]+\d+)(\.e)?(?:@([\d.]+))?([+-][\d.]+)?$", str(spec).strip())
    if not m or m.group(1) not in beats:
        sys.exit(f"content.yaml: '{spec}' is not a timing that names a narration beat.")
    b = beats[m.group(1)]
    t = b["e"] if m.group(2) else b["s"]
    if m.group(3):
        t = b["s"] + (b["e"] - b["s"]) * float(m.group(3))
    return t + float(m.group(4) or 0)


def cut_live(live: dict, scene: dict, beats: dict) -> None:
    """Cut the recorded guided-demo run (demo/live/run.mp4) into demo/live.mp4, exactly as long as
    the scene, each part sped up (or held on its last frame) to fill its stretch of the narration."""
    import imageio_ffmpeg

    src = HERE / live.get("recording", "live/run.mp4")
    meta_file = src.with_suffix(".json")
    if not src.exists() or not meta_file.exists():
        sys.exit(f"{src.name} is missing. Record a run first:  uv run demo/record_live.py  (see demo/README.md)")
    meta = json.loads(meta_file.read_text())
    steps = [b for b in meta["beats"] if b.get("title")]
    marks = {b["event"]: b["t"] for b in meta["beats"] if b.get("event")}
    titles = [b["title"] for b in steps]

    def start_of(title: str) -> float:
        if title not in titles:
            sys.exit(f"content.yaml: the recording has no step called '{title}'. It has:\n  " + "\n  ".join(titles))
        return steps[titles.index(title)]["t"]

    def end_of(title: str) -> float:
        i = titles.index(title)
        return steps[i + 1]["t"] if i + 1 < len(steps) else meta["duration"]

    cuts = live.get("cuts") or []
    keep = float(live.get("keep_top", 1.0))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    plan = []
    for i, c in enumerate(cuts):
        on = scene["s"] if i == 0 else when(c["at"], beats)
        off = when(cuts[i + 1]["at"], beats) if i + 1 < len(cuts) else scene["e"]
        a = (marks[c["from_event"]] if "from_event" in c else start_of(c["show"])) + float(c.get("skip", 0))
        b = a + float(c["take"]) if "take" in c else end_of(c.get("to", c["show"]))
        plan.append((round(a, 2), round(b - a, 2), round(off - on, 3)))
    ident = json.dumps([plan, keep, src.stat().st_mtime_ns], sort_keys=True)
    stamp = CACHE / "live.key"
    out = HERE / "live.mp4"
    if out.exists() and stamp.exists() and stamp.read_text() == ident:
        return
    work = CACHE / "live-parts"
    work.mkdir(parents=True, exist_ok=True)
    names = []
    for n, (a, have, want) in enumerate(plan):
        factor = min(want / have, 1.0)  # never slower than real time; hold the last frame instead
        hold = max(0.0, want - have * factor)
        chain = f"crop=iw:trunc(ih*{keep}/2)*2:0:0,setpts=PTS*{factor:.5f},fps=30,scale=1920:-2:flags=lanczos"
        if hold > 0.02:
            chain += f",tpad=stop_mode=clone:stop_duration={hold:.3f}"
        name = f"{n:02d}.mp4"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-ss", f"{a}", "-t", f"{have}", "-i", str(src), "-an", "-vf", chain,
             "-t", f"{want}", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", str(work / name)],
            check=True,
        )  # fmt: skip
        names.append(name)
        print(f"  live {n + 1:2}/{len(plan)}  {have:5.1f}s of the run -> {want:4.1f}s  (x{1 / factor:.1f})  {cuts[n].get('show', cuts[n].get('from_event'))}")
    (work / "list.txt").write_text("".join(f"file '{n}'\n" for n in names))
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", str(out)],
        cwd=work, check=True,
    )  # fmt: skip
    shutil.rmtree(work)
    stamp.write_text(ident)


def load_env() -> None:
    """Read KEY=value lines from demo/.env (git-ignored) so the API key need not be exported."""
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            name, sep, value = line.strip().partition("=")
            if sep and name and not name.startswith("#"):
                os.environ.setdefault(name.strip(), value.strip().strip("'\""))


def main() -> None:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", action="store_true", help="also render demo/briefing.mp4")
    args = ap.parse_args()

    try:
        # BaseLoader keeps every value as text, so "00:14" or "38%" never turn into numbers.
        content = yaml.load((HERE / "content.yaml").read_text(), Loader=yaml.BaseLoader)
    except yaml.YAMLError as err:
        sys.exit(f"content.yaml could not be read:\n{err}\n\nTip: put quotes around a value that contains ': ' or ' #'.")

    voice = content.get("voice", "bm_george")
    speed = float(content.get("speed", 1.0))
    engine = content.get("voice_engine", "kokoro")
    eleven_cfg = content.get("elevenlabs") or {}
    if engine not in ("kokoro", "elevenlabs"):
        sys.exit(f"content.yaml: voice_engine must be kokoro or elevenlabs, not '{engine}'.")
    pacing = content.get("pacing", {})
    lead_in, gap, tail = (float(pacing.get(k, d)) for k, d in (("lead_in", 0.9), ("gap", 0.32), ("tail", 0.75)))

    parts: list[np.ndarray] = []
    cursor = 0.0
    scenes, beats, screens, words = [], {}, {}, 0

    def add(audio: np.ndarray) -> None:
        nonlocal cursor
        parts.append(audio)
        cursor += len(audio) / RATE

    for scene_id, scene in content["scenes"].items():
        start = cursor
        add(silence(lead_in))
        for n, (beat_id, line) in enumerate((scene.get("narration") or {}).items()):
            caption = line["text"] if isinstance(line, dict) else line
            spoken = line.get("say", caption) if isinstance(line, dict) else line
            if beat_id in beats:
                sys.exit(f"content.yaml: narration beat id '{beat_id}' is used twice; ids must be unique.")
            if n:
                add(silence(gap))
            audio = soften(synth(spoken, voice, speed, engine, eleven_cfg))
            beats[beat_id] = {"s": round(cursor, 2), "e": round(cursor + len(audio) / RATE, 2), "text": caption}
            words += len(caption.split())
            add(audio)
        add(silence(tail))
        scenes.append({"id": scene_id, "title": scene.get("chapter", scene_id), "s": round(start, 2), "e": round(cursor, 2)})
        screens[scene_id] = scene.get("screen") or {}
        print(f"{scene_id:5} {start:6.1f} -> {cursor:6.1f}  ({cursor - start:4.1f}s)")

    problems = []
    for scene_id, screen in screens.items():
        for where, spec in timing_refs(screen):
            m = SPEC.match(str(spec).strip())
            if not m:
                problems.append(f"  {scene_id}.{where}: '{spec}' is not a timing (expected e.g. p2, p2.e, p2@0.5, p2+1.5)")
            elif m.group(1) not in beats:
                problems.append(f"  {scene_id}.{where}: '{spec}' names beat '{m.group(1)}', which is not in any narration")
    if problems:
        print("\nTimings that will never fire (those elements stay hidden):\n" + "\n".join(problems) + "\n")

    track = np.concatenate(parts)
    track *= 0.89 / max(float(np.abs(track).max()), 1e-6)
    wav = HERE / "narration.wav"
    sf.write(wav, track, RATE)
    subprocess.run(
        ["afconvert", "-f", "mp4f", "-d", "aac", "-b", "64000", str(wav), str(HERE / "narration.mp4")],
        check=True,
    )
    wav.unlink()

    for scene in scenes:
        live = screens[scene["id"]].get("live")
        if live:
            cut_live(live, scene, beats)

    timeline = {"duration": round(cursor, 2), "voice": voice, "scenes": scenes, "beats": beats}
    page_content = {"hud": content.get("hud", ""), "player": content.get("player", {}), "scenes": screens}
    page = HERE / "briefing.html"
    html = page.read_text()
    for name, data in (("TIMELINE", timeline), ("CONTENT", page_content)):
        marker = re.compile(rf"/\*{name}\*/.*?/\*END\*/", re.S)
        if not marker.search(html):
            sys.exit(f"briefing.html has no /*{name}*/ block to fill in.")
        # "</" must not appear inside a <script>, so it cannot close the tag early.
        blob = f"/*{name}*/" + json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/") + "/*END*/"
        html = marker.sub(lambda _: blob, html, count=1)
    page.write_text(html)

    label = f"{voice} x{speed}" if engine == "kokoro" else f"ElevenLabs {eleven_cfg.get('model', 'eleven_v3')} x{eleven_cfg.get('speed', '1.0')}"
    print(f"total {int(cursor // 60)}:{cursor % 60:04.1f}  {words} words  voice {label}")
    if ROUGH:
        print("Still cut off at an edge after every retake (rewording the line usually fixes it):\n  " + "\n  ".join(ROUGH))
    if cursor > LIMIT:
        print(f"WARNING: {cursor - LIMIT:.0f}s over the five-minute limit. Trim narration or raise `speed`.")
    if args.video:
        subprocess.run([sys.executable, str(HERE / "render.py")], check=True)


if __name__ == "__main__":
    main()
