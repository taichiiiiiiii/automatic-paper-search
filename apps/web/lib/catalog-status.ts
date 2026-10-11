/**
 * The catalog's result-count line (design doc 53 「学会の論文一覧」).
 * One wording for every state, so the reader can always tell three
 * numbers apart: how many papers match, how many the conference has, and
 * how many are rendered so far (the list grows by "さらに表示").
 *
 * Before the audit the line switched between "30 / 548 件を表示（全 6552
 * 件）" and "548 / 6552 件" depending on whether the list was fully
 * revealed, and the first number meant "shown" in one form and
 * "matching" in the other.
 */

const NUMBER = new Intl.NumberFormat("ja-JP");

export function formatCount(n: number): string {
  return NUMBER.format(n);
}

export function resultSummary({
  matched,
  shown,
  total,
}: {
  matched: number;
  shown: number;
  total: number;
}): string {
  const head =
    matched === total
      ? `全 ${formatCount(total)} 件`
      : `${formatCount(matched)} 件が該当（全 ${formatCount(total)} 件）`;
  if (matched === 0 || shown >= matched) return head;
  return `${head} · 先頭 ${formatCount(shown)} 件を表示中`;
}
