/**
 * Byte-for-byte request-body parity against real CPython.
 *
 * `fixtures/python-request-bodies.json` was captured by running the actual
 * `paperpilot.llm.groq_provider.GroqProvider`/`gemini_provider.GeminiProvider`
 * against the SAME inputs used below, with `request_with_retry` mocked to
 * record `(method, url, headers, json_body, timeout)` instead of making a
 * real HTTP call (`uv run --extra dev python <capture script>`, kept in the
 * session scratchpad, not committed — only its output is). This is the
 * "capture the payload Python sends with a mocked request_with_retry and
 * compare" parity check the P4d brief asks for.
 *
 * Also pins `SYSTEM_PROMPT`/`CLASSIFY_SYSTEM_PROMPT` byte-for-byte: both are
 * embedded verbatim inside the captured `json_body`.
 *
 * Content-Type is intentionally excluded from the comparison: Python's
 * provider sets it explicitly, while the TS port relies on
 * `requestWithRetry` adding it automatically for any `jsonBody` request
 * (never duplicated by the provider itself) — a documented, intentional
 * difference, not a parity gap.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RequestWithRetryOptions } from "../../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { GeminiProvider } from "../../../src/lineage/llm/gemini.js";
import { GroqProvider } from "../../../src/lineage/llm/groq.js";

interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  json_body: unknown;
  timeout: number;
}

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const pythonBodies: Record<string, CapturedCall> = JSON.parse(
  readFileSync(join(fixturesDir, "fixtures", "python-request-bodies.json"), "utf-8"),
);

function mkPaper(title: string): Paper {
  return createPaper({
    title,
    authors: ["A"],
    abstract: "An abstract with some content.",
    url: `http://x/${title}`,
    publishedDate: "2026-01-01",
    source: "arxiv",
    categories: ["cs.CL"],
    venue: "ICLR",
    githubStars: 42,
    citationCount: 7,
  });
}
const papers = [mkPaper("Paper One"), mkPaper("Paper Two")];

function unreachableFetch(): never {
  throw new Error("fetchImpl should not be called when requestWithRetryFn is injected");
}

/** Compares against the Python capture, ignoring Content-Type (see module doc). */
function expectMatchesPython(key: string, opts: RequestWithRetryOptions): void {
  const py = pythonBodies[key];
  expect(opts.method).toBe(py?.method);
  expect(opts.url).toBe(py?.url);
  expect(opts.jsonBody).toEqual(py?.json_body);
  expect((opts.timeoutMs ?? 0) / 1000).toBe(py?.timeout);
  const headers = { ...(opts.headers ?? {}) };
  delete headers["content-type"];
  delete headers["Content-Type"];
  const pyHeaders = { ...(py?.headers ?? {}) };
  delete pyHeaders["Content-Type"];
  expect(headers).toEqual(pyHeaders);
}

describe("request-body parity vs real CPython", () => {
  it("groq evaluateBatch: verbatim SYSTEM_PROMPT + evaluation prompt match Python byte-for-byte", async () => {
    let captured: RequestWithRetryOptions | undefined;
    const p = new GroqProvider(
      { enabled: true, model: "llama-3.3-70b-versatile", temperature: 0.2, timeoutSeconds: 60 },
      "gsk_x",
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async (opts) => {
          captured = opts;
          return { status: 200, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
        },
      },
    );
    await p.evaluateBatch(papers, "RAG research profile");
    expectMatchesPython("groq_eval", captured as RequestWithRetryOptions);
  });

  it("groq classifyRelation: verbatim CLASSIFY_SYSTEM_PROMPT + classify prompt match Python byte-for-byte", async () => {
    let captured: RequestWithRetryOptions | undefined;
    const p = new GroqProvider({ enabled: true }, "gsk_x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async (opts) => {
        captured = opts;
        return {
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ relation: "extends", confidence: 0.8, rationale: "x" }),
                },
              },
            ],
          }),
        };
      },
    });
    await p.classifyRelation(
      { title: "AlphaNet", year: 2020, abstract: "First idea." },
      { title: "BetaNet", year: 2024, abstract: "Improved version." },
    );
    expectMatchesPython("groq_classify", captured as RequestWithRetryOptions);
  });

  it("gemini evaluateBatch: request shape + prompts match Python byte-for-byte", async () => {
    let captured: RequestWithRetryOptions | undefined;
    const p = new GeminiProvider(
      { enabled: true, model: "gemini-1.5-flash", temperature: 0.2, timeoutSeconds: 60 },
      "g_k",
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async (opts) => {
          captured = opts;
          return {
            status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }),
          };
        },
      },
    );
    await p.evaluateBatch(papers, "RAG research profile");
    expectMatchesPython("gemini_eval", captured as RequestWithRetryOptions);
  });
});
