"""Build the NightWatch hackathon one-pager and its outage-hours chart.

    python3 demo/onepager/build.py

Writes, next to this file:
  chart.svg       the cumulative outage-hours bar chart
  onepager.html   the one-pager (1600x900), in the briefing's printed case-file look
  chart.png       the chart alone, 2x, for pasting into slides
  onepager.png    the whole one-pager, 2x

Numbers come from demo/content.yaml (the `cost` and `result` scenes): P1 averages
1 h 18 min, P2 3 h 23 min, 20 P1s and 90 P2s a year, and NightWatch halves both.
Product logos are read from demo/briefing.html so they stay identical to the video.
"""

import html
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# ---------- numbers ----------
P1 = {"n": 20, "today": 78, "agent": 39}  # minutes per incident
P2 = {"n": 90, "today": 203, "agent": 101.5}
TODAY = (P1["n"] * P1["today"] + P2["n"] * P2["today"]) / 60  # hours a year
AGENT = (P1["n"] * P1["agent"] + P2["n"] * P2["agent"]) / 60
YEARS = [1, 2, 3, 4, 5]

# ---------- palette (matches demo/briefing.html) ----------
C = {
    "paper": "#f6f5f2",
    "card": "#ffffff",
    "ink": "#191919",
    "muted": "#6c6b66",
    "line": "#d8d6cf",
    "red": "#b42318",
    "today": "#e3b9b3",  # outage today: a soft version of the briefing's failing red
    "green": "#1c7c4a",
}
# CODI, the KeyBank Codebase Analyst: green angle brackets on a black tile
CODI = (
    '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#0d0d0d"/>'
    '<path d="M12.5 10.5 7 16l5.5 5.5M19.5 10.5 25 16l-5.5 5.5" fill="none" stroke="#3ddc4a" stroke-width="3.2" '
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
)
SANS = "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif"
MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace"


def fmt(v: float) -> str:
    return f"{round(v):,}"


def chart_svg(w: int = 660, h: int = 400) -> str:
    m = {"t": 44, "r": 12, "b": 56, "l": 70}
    iw, ih = w - m["l"] - m["r"], h - m["t"] - m["b"]
    top = 1800
    y = lambda v: m["t"] + ih - v / top * ih  # noqa: E731
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
        f'font-family="{SANS}" role="img" aria-label="Cumulative outage hours from P1 and P2 incidents, today and with NightWatch, years 1 to 5">',
        f'<rect width="{w}" height="{h}" fill="{C["card"]}"/>',
    ]
    # legend
    lx = m["l"]
    for label, fill in (("Today", C["today"]), ("With NightWatch", C["ink"])):
        out.append(f'<rect x="{lx}" y="12" width="12" height="12" fill="{fill}"/>')
        out.append(f'<text x="{lx + 18}" y="22.5" font-size="13" fill="{C["ink"]}">{label}</text>')
        lx += 18 + len(label) * 7.4 + 22
    out.append(f'<rect x="{lx + .75}" y="12.75" width="10.5" height="10.5" fill="{C["green"]}" fill-opacity=".08" stroke="{C["green"]}" stroke-width="1.5" stroke-dasharray="3 2"/>')
    out.append(f'<text x="{lx + 18}" y="22.5" font-size="13" fill="{C["green"]}" font-weight="600">Hours saved</text>')
    # grid
    for t in range(0, top + 1, 300):
        out.append(f'<line x1="{m["l"]}" x2="{w - m["r"]}" y1="{y(t):.1f}" y2="{y(t):.1f}" stroke="{C["line"]}" stroke-width="1"/>')
        out.append(f'<text x="{m["l"] - 10}" y="{y(t) + 4:.1f}" font-size="12" text-anchor="end" fill="{C["muted"]}" font-family="{MONO}">{fmt(t)}</text>')
    cy = m["t"] + ih / 2
    out.append(f'<text x="12" y="{cy}" transform="rotate(-90 12 {cy})" font-size="12" text-anchor="middle" fill="{C["muted"]}" letter-spacing=".06em">HOURS OF OUTAGE</text>')
    band = iw / len(YEARS)
    bw, gap = 38, 6
    for i, n in enumerate(YEARS):
        cx = m["l"] + band * i + band / 2
        tx, ax = cx - bw - gap / 2, cx + gap / 2
        today, agent = TODAY * n, AGENT * n
        for x, v, fill, tc in ((tx, today, C["today"], C["muted"]), (ax, agent, C["ink"], C["ink"])):
            out.append(f'<rect x="{x:.1f}" y="{y(v):.1f}" width="{bw}" height="{y(0) - y(v):.1f}" fill="{fill}"/>')
            out.append(f'<text x="{x + bw / 2:.1f}" y="{y(v) - 7:.1f}" font-size="12" text-anchor="middle" fill="{tc}" font-weight="600" font-family="{MONO}">{fmt(v)}</text>')
        # hours saved: the gap between the two, drawn as a green outline on top of the NightWatch bar
        y1, y2 = y(today), y(agent) - 20
        out.append(f'<rect x="{ax + 1:.1f}" y="{y1:.1f}" width="{bw - 2}" height="{y2 - y1 - 2:.1f}" fill="{C["green"]}" fill-opacity=".08" stroke="{C["green"]}" stroke-width="1.5" stroke-dasharray="4 3"/>')
        out.append(f'<text x="{ax + bw / 2:.1f}" y="{y1 - 7:.1f}" font-size="12" text-anchor="middle" fill="{C["green"]}" font-weight="700" font-family="{MONO}">−{fmt(today - agent)}</text>')
        out.append(f'<text x="{cx:.1f}" y="{y(0) + 22:.1f}" font-size="13" text-anchor="middle" fill="{C["ink"]}" font-weight="500">Year {n}</text>')
    out.append(f'<text x="{m["l"] + iw / 2:.1f}" y="{h - 8}" font-size="12" text-anchor="middle" fill="{C["muted"]}" letter-spacing=".06em">YEARS, ADDED UP</text>')
    out.append("</svg>")
    return "\n".join(out)


def radar(size: int, blip: tuple[float, float] = (62, 0.55), sid: str = "r") -> str:
    """The NightWatch mark from the briefing, drawn still: rings, cross-hairs, a sweep, one red blip."""
    import math

    r = 50
    a = math.radians(blip[0] - 90)
    bx, by = 50 + math.cos(a) * blip[1] * r, 50 + math.sin(a) * blip[1] * r
    # sweep: a 100-degree wedge trailing the blip, fading out
    a0, a1 = math.radians(blip[0] - 90 - 100), math.radians(blip[0] - 90 + 4)
    p0 = (50 + math.cos(a0) * 49, 50 + math.sin(a0) * 49)
    p1 = (50 + math.cos(a1) * 49, 50 + math.sin(a1) * 49)
    return f"""<svg viewBox="0 0 100 100" width="{size}" height="{size}" aria-hidden="true">
  <defs><linearGradient id="{sid}g" gradientUnits="userSpaceOnUse" x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p1[0]:.1f}" y2="{p1[1]:.1f}">
    <stop offset="0" stop-color="{C['ink']}" stop-opacity="0"/><stop offset="1" stop-color="{C['ink']}" stop-opacity=".28"/></linearGradient></defs>
  <path d="M50 50 L{p0[0]:.1f} {p0[1]:.1f} A49 49 0 0 1 {p1[0]:.1f} {p1[1]:.1f} Z" fill="url(#{sid}g)"/>
  <g fill="none" stroke="{C['ink']}"><circle cx="50" cy="50" r="49" stroke-width="2"/>
  <g stroke-width="1" opacity=".4"><circle cx="50" cy="50" r="33"/><circle cx="50" cy="50" r="16.5"/><path d="M50 1V99M1 50H99"/></g></g>
  <circle cx="{bx:.1f}" cy="{by:.1f}" r="4.5" fill="#e5484d"/>
</svg>"""


def page(chart: str, logos: dict[str, str]) -> str:
    def lg(k: str) -> str:
        return f'<span class="lg">{logos[k]}</span>'

    powered = [
        ("gemini", "Gemini", "reasoning"),
        ("gcloud", "Cloud Logging", "logs and alerts"),
        ("gitlab", "GitLab", "code and fixes"),
        ("servicenow", "ServiceNow", "incidents"),
        ("teams", "Teams", "chat and calls"),
        ("codi", "CODI", "codebase analyst"),
    ]
    steps = [
        ("Detect", "Watches production logs, alerts and new ServiceNow incidents around the clock, and spots trouble within seconds."),
        ("Report", "Opens the incident and runs KeyBank's Critical Incident Management process, ServiceNow records included."),
        ("Assemble", "Sets up the Teams channel and call, and brings in the right support teams and engineers."),
        ("Remediate", "Traces the failure to the change that caused it, explains it in plain words, and proposes a fix for an engineer to approve. Then it closes out the paperwork."),
    ]
    team = ["Ashley Martin", "Alex Fraade", "Brady Huddleston", "Igor Amidzic", "Keith Ferriols", "Scott Lindsey"]
    e = html.escape
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>NightWatch One-Pager</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap">
<style>
/* Layout: a fixed 1600x900 sheet. Left column: who we are and what it saves (the chart).
   Right column: the problem, how NightWatch solves it, and what it runs on.
   The briefing's printed case-file look: paper, ink, hairlines, red only for failure, green for what's saved. */
:root {{
  --paper: {C['paper']}; --card: {C['card']}; --ink: {C['ink']}; --muted: {C['muted']};
  --line: {C['line']}; --red: {C['red']}; --green: {C['green']};
  --sans: {SANS}; --mono: {MONO};
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; background: var(--paper); }}
body {{ width: 1600px; height: 900px; color: var(--ink); font-family: var(--sans); overflow: hidden; }}
.sheet {{ height: 100%; display: grid; grid-template-rows: 52px 1fr; }}
.strip {{ display: flex; align-items: center; justify-content: space-between; padding: 0 40px; border-bottom: 1px solid var(--line); font: 500 12.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }}
.strip span {{ display: inline-flex; align-items: center; gap: 10px; }}
.strip b {{ color: var(--ink); font-weight: 600; }}
.body {{ display: grid; grid-template-columns: 700px 1fr; gap: 36px; padding: 30px 40px 32px; min-height: 0; }}
.col {{ display: flex; flex-direction: column; gap: 22px; min-height: 0; }}
.kicker {{ font: 500 12.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }}

.brand {{ display: grid; grid-template-columns: 1fr 128px; gap: 24px; align-items: center; }}
.brand h1 {{ font-size: 84px; line-height: .95; font-weight: 300; letter-spacing: -.045em; margin: 10px 0 14px -4px; }}
.brand h1 b {{ font-weight: 700; }}
.lede {{ font-size: 19px; line-height: 1.4; margin: 0; max-width: 520px; }}
.team {{ display: flex; flex-wrap: wrap; gap: 6px 0; font-size: 14px; color: var(--muted); margin-top: 14px; }}
.team span {{ padding-right: 12px; margin-right: 12px; border-right: 1px solid var(--line); }}
.team span:last-child {{ border-right: 0; }}

.card {{ background: var(--card); border: 1px solid var(--line); padding: 22px 26px; }}
.card h2 {{ font-size: 26px; line-height: 1.15; font-weight: 600; letter-spacing: -.02em; margin: 6px 0 10px; text-wrap: balance; }}
.card p {{ font-size: 16.5px; line-height: 1.5; margin: 0; }}
.chartcard {{ padding: 18px 20px 10px; flex: 1; display: flex; flex-direction: column; gap: 4px; }}
.chartcard h2 {{ font-size: 22px; margin: 4px 0 6px; }}
.chartcard h2 em {{ font-style: normal; color: var(--green); }}
.chartcard svg {{ display: block; width: 100%; height: auto; }}

.facts {{ display: flex; gap: 10px; margin-top: 14px; }}
.fact {{ flex: 1; border-top: 2px solid var(--red); padding-top: 8px; }}
.fact b {{ display: block; font: 600 20px var(--mono); letter-spacing: -.01em; }}
.fact span {{ font-size: 13.5px; color: var(--muted); }}

.steps {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px 28px; margin-top: 14px; }}
.step b {{ display: flex; align-items: baseline; gap: 10px; font-size: 18px; font-weight: 600; margin-bottom: 3px; }}
.step b i {{ font: 500 12px var(--mono); font-style: normal; color: var(--muted); }}
.step p {{ font-size: 15px; line-height: 1.45; color: #2e2d2a; }}

.powered {{ margin-top: auto; }}
.logos {{ display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-top: 10px; }}
.logo {{ display: grid; justify-items: start; gap: 8px; background: var(--card); border: 1px solid var(--line); padding: 12px 12px 11px; }}
.lg {{ display: grid; place-items: center; width: 30px; height: 30px; }}
.lg svg {{ display: block; width: 100%; height: 100%; }}
.logo b {{ display: block; font-size: 14px; font-weight: 600; line-height: 1.2; }}
.logo span {{ font-size: 12px; white-space: nowrap; color: var(--muted); }}
</style></head>
<body><div class="sheet">
  <div class="strip">
    <span>{radar(20, sid='s')}Operation <b>NightWatch</b></span>
    <span>KeyBank Hackathon 2026 · Mission: Is Possible</span>
  </div>
  <div class="body">
    <div class="col">
      <div class="brand">
        <div>
          <div class="kicker">Team Basilisk presents</div>
          <h1>Night<b>Watch</b></h1>
          <p class="lede">An AI agent that spots the incident, files the report, assembles the right team and finds the fix.</p>
          <div class="team">{''.join(f'<span>{e(n)}</span>' for n in team)}</div>
        </div>
        {radar(128, sid='b')}
      </div>
      <div class="card chartcard">
        <div class="kicker">Projected business value · P1 and P2 incidents</div>
        <h2>Cutting resolution time in half saves <em>165 hours</em> of outage time a year and <em>826 hours</em> over 5 years.</h2>
        {chart}
      </div>
    </div>
    <div class="col">
      <div class="card">
        <div class="kicker" style="color:var(--red)">The problem</div>
        <h2>Critical outages stay down longer than they need to</h2>
        <p>When a critical application fails, fixing it is only part of the job. Someone has to notice, pull the right people together, hunt for the root cause, ship the fix and keep ServiceNow up to date. All of that takes time, and every hour an application is down costs the bank revenue and customers.</p>
        <div class="facts">
          <div class="fact"><b>1 hour 18 minutes</b><span>Average time to resolve a P1 today</span></div>
          <div class="fact"><b>3 hours 23 minutes</b><span>Average time to resolve a P2 today</span></div>
        </div>
      </div>
      <div class="card">
        <div class="kicker" style="color:var(--green)">The solution</div>
        <h2>NightWatch runs the incident from the first error to the last ticket</h2>
        <div class="steps">{''.join(f'<div class="step"><b><i>{i:02d}</i>{e(t)}</b><p>{e(d)}</p></div>' for i, (t, d) in enumerate(steps, 1))}</div>
      </div>
      <div class="powered">
        <div class="kicker">Powered by</div>
        <div class="logos">{''.join(f'<div class="logo">{lg(k)}<div><b>{e(n)}</b><span>{e(s)}</span></div></div>' for k, n, s in powered)}</div>
      </div>
    </div>
  </div>
</div></body></html>
"""


def shoot(src: Path, out: Path, w: int, h: int) -> None:
    subprocess.run(
        [CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=2",
         f"--window-size={w},{h}", "--virtual-time-budget=4000", f"--screenshot={out}", src.as_uri()],
        check=True, capture_output=True,
    )


def main() -> None:
    briefing = (DEMO / "briefing.html").read_text()
    logos = json.loads(re.search(r"const LOGOS = (\{.*?\});\n", briefing).group(1))
    logos["codi"] = CODI
    chart = chart_svg()
    (HERE / "chart.svg").write_text(chart)
    (HERE / "onepager.html").write_text(page(chart, logos))
    # the chart alone, padded, on the card colour
    wrap = HERE / ".chart.html"
    wrap.write_text(f'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">'
                    f'<body style="margin:0;padding:20px;background:{C["card"]}">{chart}</body>')
    shoot(wrap, HERE / "chart.png", 700, 440)
    wrap.unlink()
    shoot(HERE / "onepager.html", HERE / "onepager.png", 1600, 900)
    print(f"today {TODAY:.1f} h/yr, with NightWatch {AGENT:.1f} h/yr, saved {TODAY - AGENT:.1f} h/yr, {5 * (TODAY - AGENT):.0f} h over 5 years")


if __name__ == "__main__":
    main()
