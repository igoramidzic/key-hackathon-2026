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

    out = path.with_name(f"{path.stem}.x{speed:.2f}.wav")
    if not out.exists():
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(path),
             "-filter:a", f"atempo={min(max(speed, 0.5), 2.0):.3f}", "-ar", str(RATE), str(out)],
            check=True,
        )  # fmt: skip
    return sf.read(out, dtype="float32")[0]


def synth(text: str, voice: str, speed: float, engine: str = "kokoro", cfg: dict | None = None) -> np.ndarray:
    """One beat as mono float32 at RATE, cached on disk by engine, voice, settings and text."""
    # `speed` is applied after the fact for ElevenLabs, so it is not part of what gets cached.
    api_cfg = {k: v for k, v in (cfg or {}).items() if k != "speed"}
    ident = f"{voice}|{speed}|{text}" if engine == "kokoro" else f"11|{json.dumps(api_cfg, sort_keys=True)}|{text}"
    key = hashlib.sha1(ident.encode()).hexdigest()[:16]
    path = CACHE / f"{key}.wav"
    if engine == "elevenlabs":
        if not path.exists():
            CACHE.mkdir(exist_ok=True)
            sf.write(path, trim(eleven(text, api_cfg)), RATE)
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


def trim(audio: np.ndarray, threshold: float = 0.01, pad: float = 0.04) -> np.ndarray:
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
            audio = synth(spoken, voice, speed, engine, eleven_cfg)
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
    if cursor > LIMIT:
        print(f"WARNING: {cursor - LIMIT:.0f}s over the five-minute limit. Trim narration or raise `speed`.")
    if args.video:
        subprocess.run([sys.executable, str(HERE / "render.py")], check=True)


if __name__ == "__main__":
    main()
