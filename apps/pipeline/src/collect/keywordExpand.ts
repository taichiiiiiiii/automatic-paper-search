/**
 * LLM-backed keyword expansion — TS port of
 * `paperpilot/utils/keyword_expand.py::expand_keywords` (COL-38 of
 * docs/migration/safety-contracts.md).
 *
 * Fail-Safe: provider unavailable / invalid JSON / empty list / a throwing
 * provider all fall back to the original keywords, each case logging a
 * WARNING so the degradation is visible (closes python issue #45 — a
 * silent fallback used to mask provider quota exhaustion).
 *
 * `_call_provider`'s `_chat`/`_messages`/`_generate` duck-typed probe
 * collapses into a single `provider.chat(...)` call — see `llm/provider.ts`
 * doc comment for why.
 */

import { parseLlmResponse } from "./jsonParser.js";
import type { LLMProvider } from "./llm/provider.js";

const SYSTEM_PROMPT = `あなたは学術論文の検索クエリ最適化アシスタントです。
与えられたキーワードに対し、同義語・略語・関連用語を英語で提案してください。

## 出力形式(厳守)
- JSON配列のみを返してください
- マークダウンのバッククォートは絶対に含めないでください
- 各要素は文字列(キーワード1つ)
- 最大15個まで
`;

function userPrompt(keywords: readonly string[], domain: string): string {
  const list = keywords.map((k) => `- ${k}`).join("\n");
  return `## 入力キーワード\n${list}\n\n## 研究分野\n${domain}\n\n上記のキーワードに対する同義語・略語・関連用語を JSON 配列で返してください。\n`;
}

export interface ExpandKeywordsOptions {
  maxExpansions?: number;
  domain?: string;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

export async function expandKeywords(
  keywords: readonly string[],
  provider: LLMProvider | null,
  options: ExpandKeywordsOptions = {},
): Promise<string[]> {
  if (keywords.length === 0) return [];
  const maxExpansions = options.maxExpansions ?? 10;
  const domain = options.domain ?? "AI / machine learning research";

  if (provider === null || !provider.enabled) {
    options.logger?.warn("keyword_expand: provider unavailable — using fallback (originals only)");
    return [...keywords];
  }

  let raw: string | null;
  try {
    raw = await provider.chat(SYSTEM_PROMPT, userPrompt(keywords, domain));
  } catch (e) {
    options.logger?.warn(
      `keyword_expand: provider raised — using fallback: ${(e as Error).message}`,
    );
    return [...keywords];
  }

  if (!raw) {
    options.logger?.warn(
      "keyword_expand: LLM returned empty response — using fallback (originals only)",
    );
    return [...keywords];
  }

  const parsed = parseLlmResponse(raw);
  if (!Array.isArray(parsed)) {
    const typeName = parsed === null ? "NoneType" : typeof parsed;
    options.logger?.warn(`keyword_expand: LLM returned non-list (${typeName}) — using fallback`);
    return [...keywords];
  }

  const seenLower = new Set<string>();
  const merged: string[] = [];
  for (const kw of keywords) {
    const key = kw.trim().toLowerCase();
    if (key && !seenLower.has(key)) {
      seenLower.add(key);
      merged.push(kw.trim());
    }
  }

  let added = 0;
  for (const item of parsed) {
    if (added >= maxExpansions) break;
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    merged.push(text);
    added += 1;
  }

  if (added === 0) {
    options.logger?.warn(
      `keyword_expand: no new keywords added (${parsed.length} returned, all duplicates) — seed discovery quality may be degraded`,
    );
  }
  options.logger?.info(`keyword_expand: ${keywords.length} -> ${merged.length} keywords`);
  return merged;
}
