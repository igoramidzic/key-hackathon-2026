# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "imageio-ffmpeg"]
# ///
"""Record a real run of the guided demo (control panel -> /demo) with a visible cursor.

    pnpm dev                      # the simulated bank, in one terminal
    pnpm demo --no-open           # the incident agent, in another
    uv run demo/record_live.py    # this: about four minutes

Drives the page in headless Chromium the way a presenter would: moves a cursor to Start and clicks
it, lets the tour advance by itself, glides the cursor to whatever each step spotlights, and
clicks Merge on the agent's fix when the tour asks for it. Nothing is staged: the page resets the
world, triggers the scenario and follows the agent live.

Writes demo/live/run.mp4 (the whole run, real time) and demo/live/run.json (when each tour step
started, and what the page said), which build.py cuts down to fit the narration.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import subprocess
import time
from pathlib import Path

import imageio_ffmpeg
from playwright.async_api import async_playwright

HERE = Path(__file__).parent
OUT = HERE / "live"
W, H, SCALE = 1440, 810, 4 / 3  # CSS viewport; captured at 1920x1080

CURSOR_JS = """
(() => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.innerHTML = `<svg width="26" height="38" viewBox="0 0 13 19"><path d="M1 1v14.5l3.6-3.3 2.5 5.6 2.2-1-2.5-5.5H12z" fill="#111" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg><i></i>`;
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(720px,420px);transition:transform .8s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))';
  const ring = c.querySelector('i');
  ring.style.cssText = 'position:absolute;left:-18px;top:-18px;width:38px;height:38px;border-radius:50%;border:3px solid #f2b441;opacity:0;transform:scale(.3)';
  document.documentElement.appendChild(c);
  window.__cursorTo = (x, y, ms) => { c.style.transitionDuration = (ms || 800) + 'ms'; c.style.transform = `translate(${x}px,${y}px)`; };
  window.__cursorClick = () => ring.animate([{opacity: .95, transform: 'scale(.3)'}, {opacity: 0, transform: 'scale(1.5)'}], {duration: 550, easing: 'ease-out'});
})();
"""

STATE_JS = """
() => {
  const q = (s) => document.querySelector(s);
  const text = (s) => (q(s)?.textContent || '').trim();
  return {
    pre: !!q('.demo-pre'),
    title: text('.demo-caption-text h2'),
    say: text('.demo-caption-text > p'),
    chapter: text('.demo-top li.now'),
    clock: text('.demo-clock'),
    needsYou: !!q('.demo-caption.needs-you'),
    error: text('.demo-error'),
  };
}
"""


async def spotlight(page):
    """Page coordinates of the first spotlight ring in any framed UI, and whether it says "click"."""
    for frame in page.frames:
        if frame is page.main_frame:
            continue
        try:
            el = await frame.frame_element()
            if not await el.is_visible():
                continue
            origin = await el.bounding_box()
            ring = await frame.evaluate(
                """() => { const r = document.querySelector('.sim-demo-ring.click') || document.querySelector('.sim-demo-ring');
                           if (!r) return null; const b = r.getBoundingClientRect();
                           return {x: b.x, y: b.y, w: b.width, h: b.height, click: r.classList.contains('click')}; }"""
            )
        except Exception:
            continue
        if ring and origin and ring["w"] > 0:
            return {**ring, "x": origin["x"] + ring["x"], "y": origin["y"] + ring["y"]}
    return None


async def main() -> None:
    ap = argparse.ArgumentParser()
    # Brisk pace: the tour reaches the Merge step about when the fix is ready, so the run's
    # "first error to restored" time measures the agent rather than the tour's reading time.
    ap.add_argument("--url", default="http://localhost:3000/demo?pace=brisk")
    ap.add_argument("--max", type=float, default=600, help="give up after this many seconds")
    args = ap.parse_args()

    frames_dir = OUT / "frames"
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir(parents=True)
    frames: list[tuple[float, str]] = []
    beats: list[dict] = []

    async with async_playwright() as pw:
        shells = sorted((Path.home() / "Library/Caches/ms-playwright").glob("chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"))
        browser = await pw.chromium.launch(executable_path=str(shells[-1])) if shells else await pw.chromium.launch()
        context = await browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=SCALE)
        page = await context.new_page()
        await page.goto(args.url)
        await page.wait_for_selector(".demo-pre-card")
        await page.evaluate(CURSOR_JS)
        start_btn = page.get_by_role("button", name="Start")
        await start_btn.wait_for()
        for _ in range(120):  # world and agent both ready
            if await start_btn.is_enabled():
                break
            await asyncio.sleep(0.5)
        else:
            raise SystemExit("Start never became available: is `pnpm dev` up and `pnpm demo` running?")

        cdp = await context.new_cdp_session(page)
        t0 = time.monotonic()

        def on_frame(ev):
            name = f"{len(frames):06d}.jpg"
            (frames_dir / name).write_bytes(base64.b64decode(ev["data"]))
            frames.append((time.monotonic() - t0, name))
            asyncio.ensure_future(cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]}))

        cdp.on("Page.screencastFrame", on_frame)
        await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "everyNthFrame": 1})

        async def glide(x, y, ms=800):
            await page.evaluate("([x, y, ms]) => window.__cursorTo(x, y, ms)", [x, y, ms])
            await page.mouse.move(x, y)
            await asyncio.sleep(ms / 1000 + 0.15)

        async def click(x, y):
            await glide(x, y)
            await page.evaluate("window.__cursorClick()")
            await asyncio.sleep(0.12)
            await page.mouse.click(x, y)

        await asyncio.sleep(1.5)
        box = await start_btn.bounding_box()
        await click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

        last, pointed, merged_click, done_at = None, None, False, None
        while time.monotonic() - t0 < args.max:
            await asyncio.sleep(0.25)
            now = time.monotonic() - t0
            s = await page.evaluate(STATE_JS)
            if s["pre"]:
                continue
            if s["title"] != last:
                last = s["title"]
                beats.append({"t": round(now, 2), **s})
                print(f"{now:6.1f}s  [{s['chapter']}] {s['title']}  ({s['clock']})", flush=True)
                pointed = None
                entered = now
            if s["error"] and not any(b.get("error") == s["error"] for b in beats[:-1]):
                print("  page error:", s["error"], flush=True)
            # A moment after each step lands, bring the cursor to what it spotlights.
            if pointed != last and now - entered > 1.3:
                spot = await spotlight(page)
                if spot:
                    if spot["click"] and s["needsYou"] and not merged_click:
                        await asyncio.sleep(2.2)  # let the audience read "your turn"
                        # The page may have scrolled the button into view since: aim at where it is now.
                        spot = await spotlight(page) or spot
                        await click(spot["x"] + spot["w"] / 2, spot["y"] + spot["h"] / 2)
                        merged_click = True
                        beats.append({"t": round(time.monotonic() - t0, 2), "event": "merge_click"})
                        print("         clicked Merge", flush=True)
                        # A click that missed (the frame was still settling) is tried again.
                        for _ in range(3):
                            await asyncio.sleep(3)
                            if not (await page.evaluate(STATE_JS))["needsYou"]:
                                break
                            spot = await spotlight(page)
                            if spot and spot["click"]:
                                await click(spot["x"] + spot["w"] / 2, spot["y"] + spot["h"] / 2)
                                print("         clicked Merge again", flush=True)
                    else:
                        # Rest just inside the bottom-right of the spotlight, not on top of its text.
                        await glide(min(spot["x"] + spot["w"] - 18, W - 30), min(spot["y"] + spot["h"] - 10, H - 130))
                    pointed = last
                elif now - entered > 4:
                    pointed = last
            # The recap is the last step and never advances: stop a few seconds after it lands.
            if done_at is None and await page.evaluate("() => !!document.querySelector('.demo-recap')"):
                done_at = now
            if done_at is not None and now - done_at > 6:
                break

        await cdp.send("Page.stopScreencast")
        total = time.monotonic() - t0
        await browser.close()

    # Screencast frames arrive only when the page changes, so write each with its own duration.
    lines = []
    for (t, name), nxt in zip(frames, [f[0] for f in frames[1:]] + [total]):
        lines += [f"file 'frames/{name}'", f"duration {max(nxt - t, 0.001):.4f}"]
    lines.append(f"file 'frames/{frames[-1][1]}'")
    (OUT / "frames.txt").write_text("\n".join(lines) + "\n")
    subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt",
         "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "run.mp4"],
        cwd=OUT, check=True,
    )  # fmt: skip
    (OUT / "run.json").write_text(json.dumps({"duration": round(total, 2), "beats": beats}, indent=1) + "\n")
    shutil.rmtree(frames_dir)
    (OUT / "frames.txt").unlink()
    print(f"wrote {OUT / 'run.mp4'} ({total:.0f}s, {len(frames)} frames) and run.json")


asyncio.run(main())
