// Correlation identifier shared by dispatch, status polling, and run matching.
// IDs are server-generated so concurrent submissions of the same theme cannot
// attach to each other's GitHub Actions run.

// `(?![\s\S])` is an absolute-end assertion. JavaScript's `$` also matches
// immediately before a final line terminator, which would accept `%0A`-suffixed
// IDs at the status endpoint.
export const REQUEST_ID_PATTERN = /^theme-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;

export function createRequestId(randomUUID = () => globalThis.crypto.randomUUID()) {
  const uuid = randomUUID();
  const requestId = `theme-${uuid}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("randomUUID returned an invalid v4 UUID");
  }
  return requestId;
}

export function isRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function dispatchInputs(theme, requestId) {
  if (typeof theme !== "string" || !theme.trim()) {
    throw new Error("theme is required");
  }
  if (!isRequestId(requestId)) {
    throw new Error("valid request_id is required");
  }
  return { theme: theme.trim(), request_id: requestId };
}
