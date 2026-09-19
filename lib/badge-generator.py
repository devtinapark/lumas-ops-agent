#!/usr/bin/env python3
"""LumaOps badge sheet + attendee distribution chart.

Reads approved attendees from Supabase, writes a printable name-badge PDF (local only:
it contains names) and uploads an aggregate role/skill chart PNG (no PII) to Supabase Storage.

    pip install reportlab matplotlib requests
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        python lib/badge-generator.py --event evt-XXXX --out ./out

The upload needs a public Storage bucket (default "charts"; override with SUPABASE_CHARTS_BUCKET).

Uses the service-role key: run it from the founder's machine or a locked-down CI/sandbox job,
never from anything the local host can reach.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: no display in Vercel/sandbox environments
import matplotlib.pyplot as plt  # noqa: E402
import requests  # noqa: E402
from reportlab.lib.colors import HexColor  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.pdfbase.pdfmetrics import stringWidth  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

APPROVED = ("auto_approved", "host_approved")
CHARTS_BUCKET = os.environ.get("SUPABASE_CHARTS_BUCKET", "charts")

# Chart palette (single-hue magnitude encoding; validated default light surface/ink).
SURFACE, INK, INK_2, BAR = "#fcfcfb", "#0b0b0b", "#52514e", "#2a78d6"
BRAND = HexColor("#184f95")


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Missing required env var {name}")
    return value


# ---------------------------------------------------------------------------
# Supabase (PostgREST over plain HTTP; no SDK needed)
# ---------------------------------------------------------------------------
def supabase_get(path: str, params: dict, page_size: int = 1000) -> list[dict]:
    headers = {
        "apikey": env("SUPABASE_SERVICE_ROLE_KEY"),
        "authorization": f"Bearer {env('SUPABASE_SERVICE_ROLE_KEY')}",
    }
    rows: list[dict] = []
    while True:
        h = {**headers, "range-unit": "items", "range": f"{len(rows)}-{len(rows) + page_size - 1}"}
        res = requests.get(f"{env('SUPABASE_URL')}/rest/v1/{path}", params=params, headers=h, timeout=30)
        res.raise_for_status()
        batch = res.json()
        rows.extend(batch)
        if len(batch) < page_size:
            return rows


def fetch_event_name(luma_event_id: str) -> str:
    rows = supabase_get("event_configs", {"select": "name", "luma_event_id": f"eq.{luma_event_id}"})
    return rows[0]["name"] if rows else luma_event_id


def fetch_approved(luma_event_id: str) -> list[dict]:
    return supabase_get(
        "attendee_evaluations",
        {
            "select": "full_name,role,skills,github_url",
            "luma_event_id": f"eq.{luma_event_id}",
            "status": f"in.({','.join(APPROVED)})",
            "order": "full_name.asc",
        },
    )


# ---------------------------------------------------------------------------
# Badge PDF (A4, 2 x 4 grid, cut guides)
# ---------------------------------------------------------------------------
COLS, ROWS = 2, 4
BADGE_W, BADGE_H = 90 * mm, 62 * mm


def pdf_safe(text: str | None, fallback: str = "") -> str:
    """Built-in PDF fonts are WinAnsi: keep accents (Medellín names), drop emoji/CJK."""
    safe = (text or fallback).encode("cp1252", errors="ignore").decode("cp1252")
    return re.sub(r"\s+", " ", safe).strip()


def fit_font(text: str, font: str, max_width: float, start: float, floor: float = 12) -> float:
    size = start
    while size > floor and stringWidth(text, font, size) > max_width:
        size -= 1
    return size


def draw_badge(c: canvas.Canvas, x: float, y: float, a: dict, event_name: str) -> None:
    c.setStrokeColor(HexColor("#c9c8c2"))
    c.setDash(2, 2)
    c.rect(x, y, BADGE_W, BADGE_H)  # cut guide
    c.setDash()

    c.setFillColor(BRAND)
    c.rect(x, y + BADGE_H - 14 * mm, BADGE_W, 14 * mm, stroke=0, fill=1)
    c.setFillColor(HexColor("#ffffff"))
    c.setFont("Helvetica-Bold", 11)
    c.drawString(x + 6 * mm, y + BADGE_H - 8.5 * mm, "VISIBLE BUILDERS")
    c.setFont("Helvetica", 7.5)
    c.drawRightString(x + BADGE_W - 6 * mm, y + BADGE_H - 8.5 * mm, pdf_safe(event_name)[:38])

    name = pdf_safe(a.get("full_name"), "Builder")
    size = fit_font(name, "Helvetica-Bold", BADGE_W - 12 * mm, 26)
    c.setFillColor(HexColor(INK))
    c.setFont("Helvetica-Bold", size)
    c.drawCentredString(x + BADGE_W / 2, y + 30 * mm, name)

    role = pdf_safe(a.get("role"))
    if role:
        c.setFillColor(HexColor(INK_2))
        c.setFont("Helvetica", 12)
        c.drawCentredString(x + BADGE_W / 2, y + 22 * mm, role[:40])

    skills = " · ".join(pdf_safe(s) for s in (a.get("skills") or [])[:4] if pdf_safe(s))
    if skills:
        c.setFillColor(BRAND)
        c.setFont("Helvetica", 9)
        c.drawCentredString(x + BADGE_W / 2, y + 10 * mm, skills[:60])


def build_badges_pdf(path: Path, attendees: list[dict], event_name: str) -> None:
    page_w, page_h = A4
    left = (page_w - COLS * BADGE_W) / 2
    top = page_h - (page_h - ROWS * BADGE_H) / 2
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle(f"Badges - {pdf_safe(event_name)}")
    per_page = COLS * ROWS
    for i, a in enumerate(attendees):
        slot = i % per_page
        if i and slot == 0:
            c.showPage()
        col, row = slot % COLS, slot // COLS
        draw_badge(c, left + col * BADGE_W, top - (row + 1) * BADGE_H, a, event_name)
    c.save()


# ---------------------------------------------------------------------------
# Distribution chart
# ---------------------------------------------------------------------------
def tally(values: list[str], limit: int) -> list[tuple[str, int]]:
    """Case-insensitive count that displays the most common spelling of each value."""
    counts: Counter[str] = Counter()
    spellings: dict[str, Counter[str]] = {}
    for v in values:
        v = re.sub(r"\s+", " ", (v or "").strip())
        if not v:
            continue
        key = v.casefold()
        counts[key] += 1
        spellings.setdefault(key, Counter())[v] += 1
    return [(spellings[k].most_common(1)[0][0], n) for k, n in counts.most_common(limit)]


SLOTS = 10  # both panels share the slot count so bar thickness matches and stays slim


def bar_panel(ax, title: str, data: list[tuple[str, int]]) -> None:
    labels, values = [d[0] for d in data], [d[1] for d in data]
    ys = [SLOTS - 1 - i for i in range(len(data))]  # biggest on top, top-aligned
    ax.barh(ys, values, height=0.55, color=BAR)
    ax.set_yticks(ys, labels)
    ax.set_ylim(-0.5, SLOTS - 0.5)
    for y, v in zip(ys, values):
        ax.text(v + max(values) * 0.015, y, str(v), va="center", ha="left", color=INK, fontsize=10)
    ax.set_title(title, loc="left", color=INK, fontsize=12, fontweight="bold", pad=10)
    ax.set_xlim(0, max(values) * 1.12)
    ax.tick_params(axis="y", length=0, labelcolor=INK_2, labelsize=10)
    ax.tick_params(axis="x", bottom=False, labelbottom=False)
    ax.set_facecolor(SURFACE)
    for spine in ax.spines.values():
        spine.set_visible(False)


def build_chart(path: Path, attendees: list[dict], event_name: str) -> None:
    roles = tally([a.get("role") or "" for a in attendees], 8)
    skills = tally([s for a in attendees for s in (a.get("skills") or [])], 10)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.6), dpi=160, facecolor=SURFACE)
    bar_panel(axes[0], "Roles", roles or [("n/a", 0)])
    bar_panel(axes[1], "Top skills", skills or [("n/a", 0)])
    fig.suptitle(
        f"{len(attendees)} approved builders · {event_name}",
        x=0.02, ha="left", color=INK, fontsize=15, fontweight="bold",
    )
    fig.text(0.02, 0.9, "Counts of approved attendees; skills and roles are AI-extracted from applications.",
             color=INK_2, fontsize=9.5)
    fig.tight_layout(rect=(0.01, 0.02, 0.99, 0.88), w_pad=4)
    fig.savefig(path, facecolor=SURFACE)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Supabase Storage upload (aggregate chart only; the badge PDF holds names and stays local)
# ---------------------------------------------------------------------------
def upload_chart(local: Path, pathname: str) -> str:
    base = env("SUPABASE_URL").rstrip("/")
    res = requests.post(
        f"{base}/storage/v1/object/{CHARTS_BUCKET}/{pathname}",
        data=local.read_bytes(),
        headers={
            "apikey": env("SUPABASE_SERVICE_ROLE_KEY"),
            "authorization": f"Bearer {env('SUPABASE_SERVICE_ROLE_KEY')}",
            "content-type": "image/png",
            "cache-control": "max-age=60",
            "x-upsert": "true",  # stable URL per event
        },
        timeout=60,
    )
    res.raise_for_status()
    return f"{base}/storage/v1/object/public/{CHARTS_BUCKET}/{pathname}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--event", required=True, help="Luma event id, e.g. evt-abc123")
    parser.add_argument("--out", default="./out", help="output directory for local files")
    parser.add_argument("--no-upload", action="store_true", help="skip the Supabase Storage upload")
    args = parser.parse_args()

    attendees = fetch_approved(args.event)
    if not attendees:
        sys.exit("No approved attendees found for that event.")
    event_name = fetch_event_name(args.event)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pdf_path, chart_path = out / f"badges-{args.event}.pdf", out / f"distribution-{args.event}.png"

    build_badges_pdf(pdf_path, attendees, event_name)
    build_chart(chart_path, attendees, event_name)
    print(f"Badges:  {pdf_path} ({len(attendees)} badges)")
    print(f"Chart:   {chart_path}")

    if not args.no_upload:
        print(f"Chart URL: {upload_chart(chart_path, f'{args.event}-distribution.png')}")


if __name__ == "__main__":
    main()
