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

from playwright.sync_api import sync_playwright

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
      <span class="brand__tagline">CONFERENCE PAPER CATALOG &middot; LINEAGE VIEW</span>

      <div class="headline">
        <div class="headline__main">Visualize the lineage<br>of <em>AI/ML papers</em>.</div>
        <div class="headline__sub">AI/ML 論文の系譜を 6 種の意味関係で可視化。</div>
      </div>

      <div class="sources">
        arXiv &middot; Semantic Scholar &middot; OpenAlex citation graph,<br>
        classified by an LLM into <strong>supersedes / successor / extends / ablation / baseline / contrasts</strong>.
      </div>
    </div>

    <div>
      <div class="tree">
        <svg viewBox="0 0 400 320" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="cs" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="{COLOR_INK}" flood-opacity="0.08"/>
            </filter>
          </defs>

          <!-- edges (coral primary, muted secondary) -->
          <path d="M 200 36 C 200 80, 80 80, 80 110" stroke="{COLOR_ACCENT}" stroke-width="2.5" fill="none"/>
          <path d="M 200 36 C 200 80, 320 80, 320 110" stroke="{COLOR_ACCENT}" stroke-width="2.5" fill="none"/>
          <path d="M 80 146 C 80 185, 20 185, 20 220" stroke="{COLOR_RULE_STRONG}" stroke-width="2" fill="none"/>
          <path d="M 80 146 C 80 185, 140 185, 140 220" stroke="{COLOR_RULE_STRONG}" stroke-width="2" fill="none"/>
          <path d="M 320 146 C 320 185, 240 185, 240 220" stroke="{COLOR_RULE_STRONG}" stroke-width="2" fill="none"/>
          <path d="M 320 146 C 320 185, 380 185, 380 220" stroke="{COLOR_RULE_STRONG}" stroke-width="2" fill="none"/>

          <!-- root card (highlighted) -->
          <g filter="url(#cs)">
            <rect x="140" y="0" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_ACCENT}" stroke-width="2"/>
            <rect x="143" y="3" width="34" height="10" rx="2" fill="#fbe4dc"/>
            <text x="147" y="11.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_ACCENT}">NeurIPS</text>
            <rect x="143" y="17" width="80" height="3" rx="1.5" fill="{COLOR_INK}"/>
            <rect x="143" y="23" width="60" height="3" rx="1.5" fill="{COLOR_INK}"/>
            <rect x="143" y="29" width="40" height="2" rx="1" fill="{COLOR_RULE_STRONG}"/>
          </g>

          <!-- mid cards -->
          <g filter="url(#cs)">
            <rect x="20" y="110" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_RULE}" stroke-width="1.5"/>
            <rect x="23" y="113" width="28" height="10" rx="2" fill="#eee9df"/>
            <text x="27" y="121.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_INK_MUTED}">ICLR</text>
            <rect x="23" y="127" width="75" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
            <rect x="23" y="133" width="55" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
          </g>
          <g filter="url(#cs)">
            <rect x="260" y="110" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_RULE}" stroke-width="1.5"/>
            <rect x="263" y="113" width="32" height="10" rx="2" fill="#eee9df"/>
            <text x="267" y="121.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_INK_MUTED}">arXiv</text>
            <rect x="263" y="127" width="70" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
            <rect x="263" y="133" width="60" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
          </g>

          <!-- leaf cards -->
          <g filter="url(#cs)">
            <rect x="-40" y="220" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_RULE}" stroke-width="1.5"/>
            <rect x="-37" y="223" width="34" height="10" rx="2" fill="#eee9df"/>
            <text x="-33" y="231.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_INK_MUTED}">CVPR</text>
            <rect x="-37" y="237" width="65" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
          </g>
          <g filter="url(#cs)">
            <rect x="80" y="220" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_RULE}" stroke-width="1.5"/>
            <rect x="83" y="223" width="28" height="10" rx="2" fill="#eee9df"/>
            <text x="87" y="231.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_INK_MUTED}">ACL</text>
            <rect x="83" y="237" width="70" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
          </g>
          <g filter="url(#cs)">
            <rect x="180" y="220" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_RULE}" stroke-width="1.5"/>
            <rect x="183" y="223" width="32" height="10" rx="2" fill="#eee9df"/>
            <text x="187" y="231.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_INK_MUTED}">EMNLP</text>
            <rect x="183" y="237" width="60" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
          </g>
          <g filter="url(#cs)">
            <rect x="320" y="220" width="120" height="36" rx="4" fill="#ffffff" stroke="{COLOR_RULE}" stroke-width="1.5"/>
            <rect x="323" y="223" width="32" height="10" rx="2" fill="#eee9df"/>
            <text x="327" y="231.2" font-family="Inter" font-size="7" font-weight="600" fill="{COLOR_INK_MUTED}">ICML</text>
            <rect x="323" y="237" width="65" height="3" rx="1.5" fill="{COLOR_INK_MUTED}"/>
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
