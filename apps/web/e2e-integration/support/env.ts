/** Ports shared by playwright.request-flow.config.ts and the tests. */
export const SITE_PORT = 4180;
export const FOREIGN_PORT = 4181;
// Not 4190: that is on the Fetch spec's blocked "bad ports" list (sieve), so
// Node's fetch refuses it.
export const MOCK_GITHUB_PORT = 4290;
export const WORKER_PORT = 8787;
export const SITE_ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
export const FOREIGN_ORIGIN = `http://127.0.0.1:${FOREIGN_PORT}`;
export const MOCK_GITHUB = `http://127.0.0.1:${MOCK_GITHUB_PORT}`;
/** Direct (test-control) address of the local Worker; the page reaches the
 * same process through its production API_BASE host. */
export const WORKER_DIRECT = `https://127.0.0.1:${WORKER_PORT}`;
