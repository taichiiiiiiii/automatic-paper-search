/**
 * Robust LLM JSON output parser — TS port of
 * `paperpilot/utils/json_parser.py::parse_llm_response`.
 *
 * Three-step fallback: (1) direct `JSON.parse`; (2) strip markdown code
 * fences and retry; (3) regex-extract the first JSON array/object
 * substring and retry. Returns the parsed value on success, `null` if all
 * steps fail.
 */

const CODE_FENCE_RE = /^```(?:json)?\s*|\s*```$/gi;
const JSON_ARRAY_RE = /\[\s*\{[\s\S]*\}\s*\]/;
const JSON_OBJECT_RE = /\{[\s\S]*\}/;

export function parseLlmResponse(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  const s = text.trim();
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }

  const cleaned = s.replace(CODE_FENCE_RE, "").trim();
  if (cleaned !== s) {
    try {
      return JSON.parse(cleaned);
    } catch {
      // fall through
    }
  }

  for (const pattern of [JSON_ARRAY_RE, JSON_OBJECT_RE]) {
    const match = pattern.exec(s);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
  }

  return null;
}
