"""Sync the lightweight summary CSV to a Google Spreadsheet (idempotent upsert).

Reads `output/iclr-2026/summary.csv` and pushes it to a Google Sheet.
- Authenticates via a service-account JSON key (path from $GOOGLE_APPLICATION_CREDENTIALS
  or --credentials).
- Re-uses an existing spreadsheet by ID ($PAPERPILOT_SHEET_ID or --sheet-id);
  creates a new one if not provided.
- Replaces the contents of the worksheet (default: "summary"), keeping the URL stable.
- Applies header bold + frozen row + Oral row highlight.

Run:
    GOOGLE_APPLICATION_CREDENTIALS=~/secrets/sa.json \
    PAPERPILOT_SHEET_ID=1AbCdEf...                     \
        python -m paperpilot.scripts.sync_to_sheets

Required deps:
    pip install -e '.[sheets]'   # gspread + google-auth
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFERENCE = "iclr-2026"
DEFAULT_TAB = "summary"

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]


def resolve_defaults(conference: str) -> tuple[Path, str]:
    """Derive (csv_path, sheet_title) from a conference slug.

    Mirrors build_lineage.derive_venue_label: acronym casing is imperfect
    (neurips-2025 -> NEURIPS 2025); pass --title explicitly when you need
    the cased form.
    """
    csv_path = ROOT / "output" / conference / "summary.csv"
    venue_label = conference.upper().replace("-", " ")
    title = f"PaperPilot — {venue_label} Summary"
    return csv_path, title


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync summary.csv to Google Sheets")
    p.add_argument(
        "--conference",
        default=DEFAULT_CONFERENCE,
        help=f"Conference slug under output/ (default: {DEFAULT_CONFERENCE}). "
             f"Drives --csv and --title defaults when they aren't set explicitly.",
    )
    p.add_argument("--csv", type=Path, default=None,
                   help="Source CSV path (default: output/<conference>/summary.csv)")
    p.add_argument(
        "--credentials",
        type=Path,
        default=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"),
        help="Service account JSON path (or $GOOGLE_APPLICATION_CREDENTIALS)",
    )
    p.add_argument(
        "--sheet-id",
        default=os.environ.get("PAPERPILOT_SHEET_ID"),
        help="Existing spreadsheet ID to update (or $PAPERPILOT_SHEET_ID); creates new if omitted",
    )
    p.add_argument("--title", default=None,
                   help="Title for newly created spreadsheet (default derived from --conference)")
    p.add_argument("--tab", default=DEFAULT_TAB, help="Worksheet (tab) name to write into")
    p.add_argument(
        "--share",
        default=os.environ.get("PAPERPILOT_SHEET_SHARE_EMAIL"),
        help="Email to share the new sheet with (writer role)",
    )
    args = p.parse_args()

    # Fill in conference-derived defaults only when the user didn't override.
    default_csv, default_title = resolve_defaults(args.conference)
    if args.csv is None:
        args.csv = default_csv
    if args.title is None:
        args.title = default_title
    return args


def load_rows(csv_path: Path) -> tuple[list[str], list[list[str]]]:
    with csv_path.open(encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = [row for row in reader]
    return header, rows


def open_or_create_sheet(client, sheet_id: str | None, title: str, share_email: str | None):
    if sheet_id:
        logger.info("Opening existing spreadsheet: %s", sheet_id)
        return client.open_by_key(sheet_id)
    logger.info("Creating new spreadsheet: %s", title)
    sh = client.create(title)
    if share_email:
        sh.share(share_email, perm_type="user", role="writer")
    return sh


def get_or_create_worksheet(sh, tab: str, rows: int, cols: int):
    try:
        ws = sh.worksheet(tab)
        ws.clear()
        ws.resize(rows=max(rows, 2), cols=max(cols, 1))
        return ws
    except Exception:
        return sh.add_worksheet(title=tab, rows=max(rows, 2), cols=max(cols, 1))


def apply_formatting(ws, header: list[str], rows: list[list[str]]) -> None:
    type_idx = header.index("type") if "type" in header else None
    last_col = chr(ord("A") + len(header) - 1)

    ws.format(f"A1:{last_col}1", {"textFormat": {"bold": True}, "backgroundColor": {"red": 0.92, "green": 0.92, "blue": 0.92}})
    ws.freeze(rows=1)

    if type_idx is not None:
        oral_ranges: list[str] = []
        for i, row in enumerate(rows, start=2):  # 2 = first data row (1 = header)
            if len(row) > type_idx and row[type_idx] == "Oral":
                oral_ranges.append(f"A{i}:{last_col}{i}")
        if oral_ranges:
            for r in oral_ranges:
                ws.format(r, {"backgroundColor": {"red": 1.0, "green": 0.95, "blue": 0.80}})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args()

    if not args.credentials:
        raise SystemExit(
            "ERROR: provide --credentials or set $GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON.\n"
            "Setup: https://docs.gspread.org/en/latest/oauth2.html#service-account"
        )
    if not args.csv.exists():
        raise SystemExit(f"ERROR: CSV not found: {args.csv}\nRun build_summary_csv.py first.")

    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError as e:
        raise SystemExit(f"ERROR: missing dependencies. Run: pip install -e '.[sheets]'\n({e})") from e

    creds = Credentials.from_service_account_file(str(args.credentials), scopes=SCOPES)
    client = gspread.authorize(creds)

    header, rows = load_rows(args.csv)
    logger.info("Loaded %d rows from %s", len(rows), args.csv.name)

    sh = open_or_create_sheet(client, args.sheet_id, args.title, args.share)
    ws = get_or_create_worksheet(sh, args.tab, rows=len(rows) + 1, cols=len(header))

    ws.update(values=[header, *rows], range_name="A1")
    apply_formatting(ws, header, rows)

    print(f"OK Synced {len(rows)} rows -> {sh.url}")
    print(f"   Spreadsheet ID: {sh.id}")
    print(f"   Tab: {args.tab}")


if __name__ == "__main__":
    main()
