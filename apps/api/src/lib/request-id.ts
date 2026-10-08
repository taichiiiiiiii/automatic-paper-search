// TS port of worker/request-id.js. See that file for the `(?![\s\S])`
// absolute-end-assertion rationale (JS `$` matches before a trailing line
// terminator, which would accept `%0A`-suffixed IDs).
//
// TODO(packages/core): move to packages/core alongside slug.ts (SCR-37 /
// PUB-38 share this definition per docs/migration/safety-contracts.md
// API-14) once that package is free of concurrent edits.

export const REQUEST_ID_PATTERN =
  /^theme-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;

export function createRequestId(
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const uuid = randomUUID();
  const requestId = `theme-${uuid}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("randomUUID returned an invalid v4 UUID");
  }
  return requestId;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function dispatchInputs(
  theme: string,
  requestId: string,
): { theme: string; request_id: string } {
  if (typeof theme !== "string" || !theme.trim()) {
    throw new Error("theme is required");
  }
  if (!isRequestId(requestId)) {
    throw new Error("valid request_id is required");
  }
  return { theme: theme.trim(), request_id: requestId };
}
