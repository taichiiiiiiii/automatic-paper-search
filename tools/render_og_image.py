"""Render the social card (og:image) via headless Chromium so we can
use real fonts (Inter + Noto Sans JP + Newsreader) including CJK glyphs
— cairosvg's font path is DejaVu / Liberation with no CJK fallback,
which is why the previous English-only version exists in #158.

Outputs:
  docs/assets/og-image.png     (1200 x 630, bilingual JP + EN)
  docs/assets/og-image.svg     (kept for reference — not used by meta tags)

Run:
  uv run python tools/render_og_image.py

The HTML lives inline below so the file is self-contained; we treat it
as a build artifact, not part of the runtime. If you tweak the design,
re-run this script and commit both the .png and the change here.
"""

from __future__ import annotations

import sys
from pathlib import Path

# NOTE: playwright is imported lazily inside main() so the module can be
# imported (e.g. to extract HTML for an alternate renderer) without the
# heavy/optional playwright dependency installed.

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PNG = REPO_ROOT / "docs" / "assets" / "og-image.png"

# Brand tokens cribbed from docs/assets/style.css. Hex because Chromium
# rendering is fine with oklch but the surrounding tools (image compressors,
# SVG fallbacks) handle hex more uniformly.
COLOR_SURFACE_TOP = "#fbf9f5"
COLOR_SURFACE_BOTTOM = "#f4f1ea"
COLOR_INK = "#1c1c25"
COLOR_INK_MUTED = "#5b5a64"
COLOR_INK_SUBTLE = "#87858f"
COLOR_ACCENT = "#d3502d"
COLOR_RULE = "#d8d3cb"
COLOR_RULE_STRONG = "#b8b0a3"
# Relation-edge palette — kept as oklch() to match docs/assets/style.css
# --rel-* tokens exactly (Chromium renders oklch in SVG fine; the output
# is a PNG so no downstream SVG tooling needs hex). The card hero on
# docs/index.html draws this same lineage with these same colors.
COLOR_REL_SUPERSEDES = "oklch(55% 0.14 75)"   # deep gold
COLOR_REL_SUCCESSOR = "oklch(72% 0.13 80)"    # light gold
COLOR_REL_EXTENDS = "oklch(62% 0.14 145)"     # green
COLOR_ORAL = "oklch(72% 0.16 75)"             # scholarly gold (root stroke)
COLOR_ORAL_BG = "oklch(95% 0.07 80)"          # gold tint (root fill)

HTML = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Newsreader:opsz,wght@16..72,500&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    html, body {{ width: 1200px; height: 630px; }}
    body {{
      font-family: 'Inter', 'Noto Sans JP', system-ui, sans-serif;
      background: linear-gradient(135deg, {COLOR_SURFACE_TOP} 0%, {COLOR_SURFACE_BOTTOM} 100%);
      color: {COLOR_INK};
      position: relative;
      overflow: hidden;
    }}
    .accent-bar {{
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 6px;
      background: {COLOR_ACCENT};
    }}
    .grid {{
      width: 100%;
      height: 100%;
      display: grid;
      grid-template-columns: 1fr 380px;
      gap: 60px;
      padding: 70px 70px 60px;
      align-items: center;
    }}
    .brand {{
      display: flex;
      flex-direction: column;
    }}
    .brand__wordmark {{
      font-family: 'Newsreader', serif;
      font-size: 44px;
      font-weight: 500;
      letter-spacing: -0.5px;
      color: {COLOR_INK};
      line-height: 1;
      font-variation-settings: "opsz" 36;
    }}
    .brand__wordmark::after {{
      content: '';
      display: block;
      width: 100px;
      height: 3px;
      background: {COLOR_ACCENT};
      margin-top: 12px;
    }}
    .brand__tagline {{
      font-size: 13px;
      font-weight: 500;
      color: {COLOR_INK_SUBTLE};
      letter-spacing: 2px;
      margin-top: 18px;
      text-transform: uppercase;
    }}
    .headline {{
      margin-top: 48px;
    }}
    .headline__main {{
      font-family: 'Inter', sans-serif;
      font-size: 46px;
      font-weight: 700;
      letter-spacing: -1.2px;
      line-height: 1.08;
      color: {COLOR_INK};
    }}
    .headline__main em {{
      font-style: normal;
      color: {COLOR_ACCENT};
    }}
    .headline__sub {{
      font-family: 'Noto Sans JP', sans-serif;
      font-size: 22px;
      font-weight: 500;
      line-height: 1.5;
      color: {COLOR_INK_MUTED};
      margin-top: 20px;
    }}
    .sources {{
      margin-top: 24px;
      font-family: 'Inter', sans-serif;
      font-size: 16px;
      color: {COLOR_INK_MUTED};
      line-height: 1.55;
    }}
    .sources strong {{
      color: {COLOR_INK};
      font-weight: 600;
    }}
    .footer-repo {{
      position: absolute;
      bottom: 28px;
      left: 70px;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      font-weight: 500;
      color: {COLOR_INK_SUBTLE};
    }}

    /* Right-side: lineage tree illustration */
    .tree {{
      position: relative;
      width: 100%;
      height: 350px;
    }}
    .tree svg {{
      width: 100%;
      height: 100%;
      overflow: visible;
    }}
    .tree__caption {{
      margin-top: 14px;
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      color: {COLOR_INK_SUBTLE};
      letter-spacing: 0.3px;
      text-align: center;
      font-weight: 500;
      white-space: nowrap;
    }}
  </style>
</head>
<body>
  <div class="accent-bar"></div>
  <div class="grid">
    <div class="brand">
      <span class="brand__wordmark">PaperPilot</span>
      <span class="brand__tagline">AI/ML PAPER LINEAGE &middot; 論文の家系図</span>

      <div class="headline">
        <div class="headline__main">The family tree<br>of <em>AI research</em>.</div>
        <div class="headline__sub">AI/ML 論文の引用を、世代をまたぐ家系図として可視化。</div>
      </div>

      <div class="sources">
        arXiv &middot; Semantic Scholar &middot; OpenAlex citation graph,<br>
        classified by an LLM into <strong>supersedes / successor / extends / ablation / baseline / contrasts</strong>.
      </div>
    </div>

    <div>
      <div class="tree">
        <!-- The same canonical lineage the page hero draws (Attention →
             BERT/GPT → ViT/Flash Attn). Edge colors are the real --rel-*
             relation tokens so the share card and the live page tell one
             story; the two newest leaves (ViT, Flash Attn) are the two
             themes that actually exist in the viewer. Old papers up,
             new papers down. -->
        <svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="cs" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="{COLOR_INK}" flood-opacity="0.08"/>
            </filter>
          </defs>

          <!-- edges: successor (light gold) + supersedes (deep gold) from
               root, extends (green dashed) into the two leaves -->
          <path d="M 200 40 C 200 84, 75 80, 75 120" stroke="{COLOR_REL_SUCCESSOR}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
          <path d="M 200 40 C 200 84, 325 80, 325 120" stroke="{COLOR_REL_SUPERSEDES}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
          <path d="M 75 160 L 75 240" stroke="{COLOR_REL_EXTENDS}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-dasharray="7 4"/>
          <path d="M 325 160 L 325 240" stroke="{COLOR_REL_EXTENDS}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-dasharray="7 4"/>

          <!-- root: Attention (2017), gold "oral-tier" ancestor -->
          <g filter="url(#cs)">
            <rect x="140" y="0" width="120" height="40" rx="6" fill="{COLOR_ORAL_BG}" stroke="{COLOR_ORAL}" stroke-width="2"/>
            <text x="200" y="20" text-anchor="middle" font-family="Newsreader, serif" font-size="16" font-weight="500" fill="{COLOR_INK}">Attention</text>
            <text x="200" y="33" text-anchor="middle" font-family="Inter" font-size="9" font-weight="500" fill="{COLOR_INK_SUBTLE}">2017</text>
          </g>

          <!-- generation 1: BERT / GPT (2018) -->
          <g filter="url(#cs)">
            <rect x="15" y="120" width="120" height="40" rx="6" fill="#ffffff" stroke="{COLOR_RULE_STRONG}" stroke-width="1.5"/>
            <text x="75" y="140" text-anchor="middle" font-family="Newsreader, serif" font-size="16" font-weight="500" fill="{COLOR_INK}">BERT</text>
            <text x="75" y="153" text-anchor="middle" font-family="Inter" font-size="9" font-weight="500" fill="{COLOR_INK_SUBTLE}">2018</text>
          </g>
          <g filter="url(#cs)">
            <rect x="265" y="120" width="120" height="40" rx="6" fill="#ffffff" stroke="{COLOR_RULE_STRONG}" stroke-width="1.5"/>
            <text x="325" y="140" text-anchor="middle" font-family="Newsreader, serif" font-size="16" font-weight="500" fill="{COLOR_INK}">GPT</text>
            <text x="325" y="153" text-anchor="middle" font-family="Inter" font-size="9" font-weight="500" fill="{COLOR_INK_SUBTLE}">2018</text>
          </g>

          <!-- generation 2 (the two live themes): ViT (2020) / Flash Attn
               (2022, newest → coral "current" ring) -->
          <g filter="url(#cs)">
            <rect x="15" y="240" width="120" height="40" rx="6" fill="#ffffff" stroke="{COLOR_RULE_STRONG}" stroke-width="1.5"/>
            <text x="75" y="260" text-anchor="middle" font-family="Newsreader, serif" font-size="16" font-weight="500" fill="{COLOR_INK}">ViT</text>
            <text x="75" y="273" text-anchor="middle" font-family="Inter" font-size="9" font-weight="500" fill="{COLOR_INK_SUBTLE}">2020</text>
          </g>
          <g filter="url(#cs)">
            <rect x="265" y="240" width="120" height="40" rx="6" fill="#ffffff" stroke="{COLOR_ACCENT}" stroke-width="2"/>
            <text x="325" y="260" text-anchor="middle" font-family="Newsreader, serif" font-size="16" font-weight="500" fill="{COLOR_INK}">Flash Attn</text>
            <text x="325" y="273" text-anchor="middle" font-family="Inter" font-size="9" font-weight="500" fill="{COLOR_INK_SUBTLE}">2022</text>
          </g>
        </svg>
        <div class="tree__caption">supersedes &middot; successor &middot; extends &middot; ablation &middot; baseline &middot; contrasts</div>
      </div>
    </div>
  </div>

  <div class="footer-repo">github.com/taichiiiiiiii/automatic-paper-search</div>
</body>
</html>
"""


def main() -> int:
    """Render the card. Returns the standard 0/1 unix exit code."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1200, "height": 630})
            page.set_content(HTML, wait_until="networkidle")
            # Give font swap one more beat — networkidle returns when the
            # CSS request finishes, but Noto Sans JP swap can lag the
            # very first paint by a frame or two.
            page.wait_for_timeout(500)
            OUTPUT_PNG.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(
                path=str(OUTPUT_PNG),
                clip={"x": 0, "y": 0, "width": 1200, "height": 630},
                omit_background=False,
            )
        finally:
            browser.close()
    size_kb = OUTPUT_PNG.stat().st_size // 1024
    print(f"wrote {OUTPUT_PNG.relative_to(REPO_ROOT)} ({size_kb} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
