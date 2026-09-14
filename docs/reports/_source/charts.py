"""Company-style (FIRST C&D) chart PNGs from a JSON spec.

Usage: py -3.11 charts.py charts.json out_dir
spec: {"charts": [{"id", "type": "bar"|"hbar"|"line"|"stacked", "labels": [...],
        "series": [{"name", "values": [...]}], "yLabel", "unit", "annotation", "highlight": [idx...],
        "width": 12.75, "height": 7.95}]}
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

FONT_DIR = Path.home() / "AppData/Local/Microsoft/Windows/Fonts"
for f in FONT_DIR.glob("Pretendard-*.otf"):
    if "_0" not in f.stem:
        font_manager.fontManager.addfont(str(f))
plt.rcParams["font.family"] = "Pretendard"
plt.rcParams["axes.unicode_minus"] = False

BLUE, BLUE_2, BLUE_3, GRAY, INK, MUTED, GRID = "#3E7EE7", "#8FB4F2", "#C9DBFA", "#9CA0A6", "#222222", "#555A60", "#ECEFF3"
LABEL_ON_GRAY = "#4A4F55"
PALETTE = [BLUE, GRAY, BLUE_2, "#5A5F66", BLUE_3]


def style_axes(ax, spec):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#D9DEE6")
    ax.tick_params(colors=MUTED, labelsize=19, length=0)
    ax.grid(axis="y" if spec["type"] != "hbar" else "x", color=GRID, linewidth=1)
    ax.set_axisbelow(True)
    if spec.get("yLabel"):
        (ax.set_xlabel if spec["type"] == "hbar" else ax.set_ylabel)(spec["yLabel"], color=MUTED, fontsize=19)


def fmt(v, unit):
    s = f"{v:,.0f}" if float(v).is_integer() else f"{v:,.1f}"
    return f"{s}{unit or ''}"


def draw(spec, out):
    fig, ax = plt.subplots(figsize=(spec.get("width", 12.75), spec.get("height", 7.95)), dpi=100)
    labels, series, unit = spec["labels"], spec["series"], spec.get("unit", "")
    hl = set(spec.get("highlight", []))
    t = spec["type"]
    if t in ("bar", "hbar"):
        n = len(series)
        width = 0.62 / n
        for si, se in enumerate(series):
            xs = [i + (si - (n - 1) / 2) * width for i in range(len(labels))]
            if n == 1:
                colors = [BLUE if (not hl or i in hl) else GRAY for i in range(len(labels))]
            else:
                colors = PALETTE[si % len(PALETTE)]
            bars = (ax.barh if t == "hbar" else ax.bar)(xs, se["values"], width * 0.92, color=colors, label=se["name"])
            texts = spec.get("valueLabels") if n == 1 and spec.get("valueLabels") else [fmt(v, unit) for v in se["values"]]
            for b, v, label in zip(bars, se["values"], texts):
                tc = LABEL_ON_GRAY if b.get_facecolor()[:3] == matplotlib.colors.to_rgb(GRAY) else b.get_facecolor()
                if t == "hbar":
                    ax.text(b.get_width(), b.get_y() + b.get_height() / 2, "  " + label, va="center",
                            fontsize=21, fontweight="bold", color=tc)
                else:
                    ax.text(b.get_x() + b.get_width() / 2, b.get_height(), label, ha="center", va="bottom",
                            fontsize=30 if n == 1 else 19, fontweight="bold", color=tc)
        if t == "hbar":
            ax.set_yticks(range(len(labels)), labels, fontsize=19)
            ax.invert_yaxis()
            ax.margins(x=0.18)
            if "xMax" in spec:
                ax.set_xlim(0, spec["xMax"])
        else:
            ax.set_xticks(range(len(labels)), labels, fontsize=19)
            ax.margins(y=0.15)
    elif t == "line":
        for si, se in enumerate(series):
            c = PALETTE[si % len(PALETTE)]
            ax.plot(labels, se["values"], color=c, linewidth=4, marker="o", markersize=9, label=se["name"])
            ax.text(len(labels) - 1, se["values"][-1], "  " + fmt(se["values"][-1], unit), va="center",
                    fontsize=21, fontweight="bold", color=c)
        for i, ref in enumerate(spec.get("refLines", [])):
            ax.axhline(ref["value"], color=MUTED, linestyle="--", linewidth=1.5)
            ax.text(0, ref["value"] + spec.get("refLabelOffset", 0.4), ref["label"], va="bottom", fontsize=18, color=MUTED)
        ax.margins(x=0.08)
        if "yMin" in spec:
            ax.set_ylim(spec["yMin"], spec.get("yMax"))
    elif t == "stacked":
        bottoms = [0] * len(labels)
        for si, se in enumerate(series):
            ax.bar(labels, se["values"], 0.55, bottom=bottoms, color=PALETTE[si % len(PALETTE)], label=se["name"])
            bottoms = [a + b for a, b in zip(bottoms, se["values"])]
        ax.tick_params(axis="x", labelsize=19)
    style_axes(ax, spec)
    if len(series) > 1 or spec.get("legend"):
        ax.legend(frameon=False, fontsize=19, loc=spec.get("legendLoc", "upper center"),
                  bbox_to_anchor=(0.5, 1.12), ncol=min(len(series), 4), labelcolor=INK)
    if spec.get("annotation"):
        ax.text(0.5, 0.97, spec["annotation"], transform=ax.transAxes, ha="center", va="top",
                fontsize=24, fontweight="bold", color=BLUE)
    fig.tight_layout()
    fig.savefig(out, dpi=100, facecolor="white")
    plt.close(fig)


if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for c in spec["charts"]:
        draw(c, out_dir / f"{c['id']}.png")
        print("chart", c["id"])
