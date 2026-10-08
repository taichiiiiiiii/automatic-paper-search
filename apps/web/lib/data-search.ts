/**
 * Typed fetch helpers for cross-conference search data, additional to
 * (never replacing) lib/data.ts's `fetchSearchIndex` -- see that file's
 * header for why new helpers go in a sibling file rather than editing
 * it directly.
 *
 * `fetchSearchIndex` in lib/data.ts validates `search-index-v2.json`
 * with a zod schema that is *weaker* than docs/assets/search.js's own
 * `validateIndex` in one respect: it does not check that each row's
 * `paper_ref` (index 2) equals its own position in the array (SCR-05:
 * "one invalid row must reject the entire index"). `loadSearchIndex`
 * below re-validates the already-parsed rows with
 * lib/search-core.ts's `validateIndex` to restore that check.
 */
import { BASE_PATH } from "@paperpilot/core/site";
import type { DataResult } from "./data";
import { fetchSearchIndex } from "./data";
import {
  BLOCK_SIZE,
  blockFile,
  type IdBlock,
  type SearchRow,
  validateIdBlock,
  validateIndex,
} from "./search-core";

function publicPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`publicPath: path must start with "/", got ${JSON.stringify(path)}`);
  }
  return `${BASE_PATH}${path}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetches + fully validates `search-index-v2.json` (lib/data.ts's own
 * zod parse, plus the `paper_ref === ordinal` contract zod can't cheaply
 * express). Fails closed: a single bad row rejects the whole index. */
export async function loadSearchIndex(): Promise<DataResult<SearchRow[]>> {
  const result = await fetchSearchIndex();
  if (result.status === "error") return result;
  try {
    return { status: "ok", data: validateIndex(result.data) };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}

/** Fetches + validates one `search-paper-ids-v1/NNNN.json` block (SCR-05:
 * a block fetched for the wrong ordinal, or with the wrong address/shape,
 * fails closed rather than resolving to a bogus paper id). */
export async function fetchSearchIdBlock(
  block: number,
  totalRows: number,
): Promise<DataResult<IdBlock>> {
  try {
    const res = await fetch(publicPath(`/${blockFile(block * BLOCK_SIZE)}`), { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`search-paper-ids-v1/${block} fetch failed: HTTP ${res.status}`);
    }
    const raw = await res.json();
    return { status: "ok", data: validateIdBlock(raw, block, totalRows) };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}
