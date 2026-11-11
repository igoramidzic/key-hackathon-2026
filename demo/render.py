# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "imageio-ffmpeg"]
# ///
"""Render demo/briefing.html to demo/briefing.mp4 (1080p, 30 fps, with the voice-over).

The page draws itself as a function of time, so instead of screen-recording it this steps
headless Chromium one frame at a time: seek, advance every CSS transition and animation to that
instant, screenshot. Several pages work through the timeline in parallel, then ffmpeg (bundled
with imageio-ffmpeg) encodes the frames with demo/narration.mp4.

    uv run demo/render.py                 # full render
    uv run demo/render.py --start 130 --end 140 --frames /tmp/f --no-encode   # spot-check frames

Uses a Chromium that Playwright has already downloaded (~/Library/Caches/ms-playwright); run
`uv run --with playwright playwright install chromium` once if there is none.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import imageio_ffmpeg
from playwright.async_api import async_playwright

HERE = Path(__file__).parent
FPS = 30
W, H = 1920, 1080
WARMUP = 2.0  # seconds stepped before a worker's first kept frame, so transitions have settled

# What the artifact host wraps the page in, so layout matches the published version.
SKELETON = (
    '<!doctype html><html><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    "<style>body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}"
    "[hidden]{display:none!important}</style></head><body><!--PAGE--></body></html>"
)
# Only the 16:9 stage, edge to edge.
CAPTURE_CSS = """
body { padding: 0 !important; overflow: hidden; }
.player { max-width: none !important; min-width: 0 !important; margin: 0 !important; }
.screen { border: 0 !important; border-radius: 0 !important; }
.bar, .chapters, .keys, .poster { display: none !important; }
"""
# Seek, then pin every running transition/animation to the same instant.
STEPPER = """
(() => {
  const started = new WeakMap();
  window.__frame = (t) => {
    window.__seek(t);
    for (const a of document.getAnimations()) {
      if (!started.has(a)) started.set(a, t);
      const transition = a instanceof CSSTransition;
      const local = transition ? (t - started.get(a)) * 1000 : t * 1000;
      a.pause();
      if (transition && local >= a.effect.getComputedTiming().endTime) a.finish();
      else a.currentTime = local;
    }
  };
})();
"""


def find_chromium() -> str | None:
    cache = Path.home() / "Library/Caches/ms-playwright"
    shells = sorted(cache.glob("chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"))
    return str(shells[-1]) if shells else None


async def worker(browser, html: str, frames: list[int], out: Path, first: int, progress: list[int]):
    page = await browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    await page.set_content(SKELETON.replace("<!--PAGE-->", html), wait_until="load")
    await page.add_style_tag(content=CAPTURE_CSS)
    await page.evaluate(
        "Promise.all(['800 40px \"Big Shoulders Display\"','500 16px \"IBM Plex Sans\"',"
        "'500 16px \"IBM Plex Mono\"','16px \"Special Elite\"'].map(f => document.fonts.load(f)))"
        ".then(() => document.fonts.ready)"
    )
    await page.evaluate(STEPPER)
    # Any start other than t=0 needs the run-up, or the title card is still fading out.
    for f in range(max(0, frames[0] - int(WARMUP * FPS)), frames[0]):
        await page.evaluate("t => window.__frame(t)", f / FPS)
    for f in frames:
        await page.evaluate("t => window.__frame(t)", f / FPS)
        await page.screenshot(path=str(out / f"{f - first:06d}.jpg"), type="jpeg", quality=93)
        progress[0] += 1
    await page.close()


async def capture(html: str, start: int, end: int, out: Path, workers: int) -> None:
    total = end - start
    size = math.ceil(total / workers)
    chunks = [list(range(a, min(a + size, end))) for a in range(start, end, size)]
    progress, t0 = [0], time.time()

    async def report():
        while progress[0] < total:
            await asyncio.sleep(20)
            done = progress[0]
            rate = done / max(time.time() - t0, 1e-6)
            print(f"  {done}/{total} frames  {rate:.1f} fps  ~{(total - done) / max(rate, 1e-6):.0f}s left", flush=True)

    async with async_playwright() as pw:
        exe = find_chromium()
        browser = await pw.chromium.launch(executable_path=exe) if exe else await pw.chromium.launch()
        ticker = asyncio.create_task(report())
        await asyncio.gather(*(worker(browser, html, c, out, start, progress) for c in chunks))
        ticker.cancel()
        await browser.close()
    print(f"captured {total} frames in {time.time() - t0:.0f}s", flush=True)


def encode(frames: Path, start_s: float, seconds: float, target: Path) -> None:
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(frames / "%06d.jpg"),
        "-ss", f"{start_s:.3f}", "-t", f"{seconds:.3f}", "-i", str(HERE / "narration.mp4"),
        "-map", "0:v", "-map", "1:a",
        # JPEG frames are full-range; convert to the limited range every player expects.
        "-vf", "scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-crf", "17",
        "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-t", f"{seconds:.3f}", "-movflags", "+faststart", str(target),
    ]  # fmt: skip
    subprocess.run(cmd, check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=float, default=0.0, help="seconds")
    ap.add_argument("--end", type=float, default=None, help="seconds (default: whole briefing)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--frames", type=Path, default=None, help="keep frames in this directory")
    ap.add_argument("--no-encode", action="store_true")
    ap.add_argument("--out", type=Path, default=HERE / "briefing.mp4")
    args = ap.parse_args()

    html = (HERE / "briefing.html").read_text()
    timeline = json.loads(re.search(r"/\*TIMELINE\*/(.*?)/\*END\*/", html, re.S).group(1))
    duration = timeline["duration"]
    start = int(args.start * FPS)
    end = math.ceil(min(args.end or duration, duration) * FPS)

    frames = args.frames or Path(tempfile.mkdtemp(prefix="briefing-frames-"))
    frames.mkdir(parents=True, exist_ok=True)
    print(f"frames {start}..{end} ({(end - start) / FPS:.1f}s) -> {frames}", flush=True)
    asyncio.run(capture(html, start, end, frames, max(1, min(args.workers, end - start))))
    if not args.no_encode:
        encode(frames, start / FPS, (end - start) / FPS, args.out)
        print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)", flush=True)
    if not args.frames:
        shutil.rmtree(frames, ignore_errors=True)


if __name__ == "__main__":
    main()
