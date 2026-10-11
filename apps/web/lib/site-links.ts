/**
 * External links shared by the footer, the 仕組み page and the theme
 * request form (R2-27: legal notices, privacy, private removal requests).
 * Kept in one place so the private-report route can move to e-mail later
 * (design 51 D2: GitHub private vulnerability reporting until the site has
 * its own domain) by editing a single constant.
 */
export const REPO_URL = "https://github.com/taichiiiiiiii/automatic-paper-search";

/** Public issues: data errors and broken links (anything safe to publish). */
export const ISSUES_URL = `${REPO_URL}/issues`;

/** Private channel for removal/correction requests, privacy and security
 * reports: GitHub private vulnerability reporting (only the maintainer can
 * read a report). */
export const PRIVATE_REPORT_URL = `${REPO_URL}/security/advisories/new`;

/** Repository-level notices (data licenses, takedown procedure). */
export const NOTICE_URL = `${REPO_URL}/blob/develop/NOTICE.md`;
export const TAKEDOWN_POLICY_URL = `${REPO_URL}/blob/develop/docs/policy/takedown.md`;

/** Privacy section on the 仕組み page. */
export const PRIVACY_PATH = "/how-it-works/#privacy";
