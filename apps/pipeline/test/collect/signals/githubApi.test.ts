/**
 * Port of `paperpilot/tests/test_utils_github.py` (the
 * `title_similarity`/`search_repo_by_title`/`fetch_repo_stars`/
 * `parse_github_repo_url` cases; `load_curated_map` is ported separately
 * in `githubMap.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { FetchLike, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  fetchRepoStars,
  GitHubUnavailableError,
  parseGithubRepoUrl,
  searchRepoByTitle,
  titleSimilarity,
} from "../../../src/collect/signals/githubApi.js";

function withFetch(fetchImpl: FetchLike) {
  return { fetchImpl, sleep: async () => {} };
}

function searchResp(items: unknown[]): HttpResponseLike {
  return { status: 200, json: async () => ({ items }) };
}

// ---------- title_similarity ----------

it("test_title_similarity_token_overlap", () => {
  const sim = titleSimilarity("Attention Is All You Need", "Transformer attention mechanism");
  expect(sim).toBeGreaterThan(0.0);
  expect(sim).toBeLessThan(0.5);
});

it("test_title_similarity_substring_shortcut", () => {
  expect(titleSimilarity("Segment Anything", "segment-anything")).toBe(1.0);
});

it("test_title_similarity_short_string_no_substring_shortcut", () => {
  expect(titleSimilarity("FCN", "fullyconvolutionalnetworks")).toBeLessThan(0.55);
});

it("test_title_similarity_empty_inputs", () => {
  expect(titleSimilarity("", "anything")).toBe(0.0);
  expect(titleSimilarity("anything", "")).toBe(0.0);
});

it("test_title_similarity_identical", () => {
  expect(titleSimilarity("Same Title", "Same Title")).toBe(1.0);
});

// ---------- search_repo_by_title ----------

it("test_search_repo_by_title_returns_first_high_similarity_hit", async () => {
  const deps = withFetch(async () =>
    searchResp([
      { full_name: "owner1/some-noise", name: "noise", description: "x" },
      { full_name: "facebookresearch/segment-anything", name: "segment-anything", description: "" },
    ]),
  );
  const out = await searchRepoByTitle("Segment Anything", {}, deps);
  expect(out).toBe("facebookresearch/segment-anything");
});

it("test_search_repo_by_title_filters_low_similarity", async () => {
  const deps = withFetch(async () =>
    searchResp([
      { full_name: "spam/random-repo", name: "random", description: "totally unrelated" },
    ]),
  );
  expect(await searchRepoByTitle("A Very Specific Paper Title", {}, deps)).toBeNull();
});

it("test_search_repo_by_title_skips_short_titles", async () => {
  let called = false;
  const deps = withFetch(async () => {
    called = true;
    return searchResp([]);
  });
  expect(await searchRepoByTitle("BERT", {}, deps)).toBeNull();
  expect(called).toBe(false);
});

it("test_search_repo_by_title_raises_when_github_is_unavailable", async () => {
  const deps1 = withFetch(async () => {
    throw new Error("network down");
  });
  await expect(searchRepoByTitle("Some Reasonable Paper", {}, deps1)).rejects.toThrow(
    GitHubUnavailableError,
  );

  for (const status of [403, 429, 503]) {
    const deps = withFetch(async () => ({ status, json: async () => ({}) }));
    await expect(searchRepoByTitle("Some Reasonable Paper", {}, deps)).rejects.toThrow(
      GitHubUnavailableError,
    );
  }
});

it("test_search_repo_by_title_returns_none_only_for_a_200_with_no_candidate", async () => {
  const deps = withFetch(async () => searchResp([]));
  expect(await searchRepoByTitle("Some Reasonable Paper", {}, deps)).toBeNull();
});

it.each([400, 401, 404, 422, 451])(
  "test_search_repo_by_title_raises_for_any_other_status (%d)",
  async (status) => {
    const deps = withFetch(async () => ({ status, json: async () => ({}) }));
    await expect(searchRepoByTitle("Some Reasonable Paper", {}, deps)).rejects.toThrow(
      GitHubUnavailableError,
    );
  },
);

it("test_fetch_repo_stars_returns_none_only_for_a_404", async () => {
  const deps = withFetch(async () => ({ status: 404, json: async () => ({}) }));
  expect(await fetchRepoStars("owner/repo", {}, deps)).toBeNull();
});

it.each([400, 401, 422, 451])(
  "test_fetch_repo_stars_raises_for_a_status_about_our_request (%d)",
  async (status) => {
    const deps = withFetch(async () => ({ status, json: async () => ({}) }));
    await expect(fetchRepoStars("owner/repo", {}, deps)).rejects.toThrow(GitHubUnavailableError);
  },
);

it("test_search_repo_by_title_refuses_a_response_carrying_an_invalid_slug", async () => {
  const deps = withFetch(async () =>
    searchResp([
      { full_name: "owner/with spaces", name: "matching title", description: "" },
      { full_name: "owner/$evil", name: "matching title", description: "" },
      { full_name: "owner/legit-matching-title", name: "matching title", description: "" },
    ]),
  );
  await expect(searchRepoByTitle("Matching Title Of Paper", {}, deps)).rejects.toThrow(
    GitHubUnavailableError,
  );
});

it("test_search_repo_by_title_returns_a_valid_slug_from_a_clean_page", async () => {
  const deps = withFetch(async () =>
    searchResp([
      { full_name: "owner/unrelated", name: "something else", description: "" },
      { full_name: "owner/legit-matching-title", name: "matching title", description: "" },
    ]),
  );
  expect(await searchRepoByTitle("Matching Title Of Paper", {}, deps)).toBe(
    "owner/legit-matching-title",
  );
});

it("test_search_repo_by_title_passes_token_via_header", async () => {
  let authHeader: string | undefined;
  const deps = withFetch(async (_url, init) => {
    authHeader = init.headers?.Authorization;
    return searchResp([]);
  });
  await searchRepoByTitle("Some Reasonable Paper", { githubToken: "ghp_xxx" }, deps);
  expect(authHeader).toBe("Bearer ghp_xxx");
});

// ---------- fetch_repo_stars ----------

it("test_fetch_repo_stars_via_github_api", async () => {
  const deps = withFetch(async () => ({
    status: 200,
    json: async () => ({ stargazers_count: 1234 }),
  }));
  expect(await fetchRepoStars("owner/repo", {}, deps)).toBe(1234);
});

it("test_fetch_repo_stars_raises_when_github_is_unavailable", async () => {
  const deps1 = withFetch(async () => {
    throw new Error("down");
  });
  await expect(fetchRepoStars("owner/repo", {}, deps1)).rejects.toThrow(GitHubUnavailableError);
  for (const status of [403, 429, 502]) {
    const deps = withFetch(async () => ({ status, json: async () => ({}) }));
    await expect(fetchRepoStars("owner/repo", {}, deps)).rejects.toThrow(GitHubUnavailableError);
  }
});

it("test_fetch_repo_stars_rejects_a_non_int_stargazer_payload", async () => {
  const deps = withFetch(async () => ({
    status: 200,
    json: async () => ({ stargazers_count: "not-a-number" }),
  }));
  await expect(fetchRepoStars("owner/repo", {}, deps)).rejects.toThrow(GitHubUnavailableError);
});

it("test_fetch_repo_stars_revalidates_slug_even_when_called_directly", async () => {
  let called = false;
  const deps = withFetch(async () => {
    called = true;
    return { status: 200, json: async () => ({ stargazers_count: 0 }) };
  });
  for (const bad of [
    "owner/with spaces",
    "owner/$evil",
    "owner/repo;rm",
    "owner/../etc",
    "/no-owner",
    "no-slash",
  ]) {
    expect(await fetchRepoStars(bad, {}, deps)).toBeNull();
  }
  expect(called).toBe(false);
});

it("test_fetch_repo_stars_passes_token", async () => {
  let authHeader: string | undefined;
  const deps = withFetch(async (_url, init) => {
    authHeader = init.headers?.Authorization;
    return { status: 200, json: async () => ({ stargazers_count: 0 }) };
  });
  await fetchRepoStars("owner/repo", { githubToken: "ghp_xxx" }, deps);
  expect(authHeader).toBe("Bearer ghp_xxx");
});

// ---- 200 envelopes that carry no answer ----

it.each([{}, { message: "API rate limit exceeded" }, { items: null }, { items: "x" }])(
  "test_search_repo_rejects_a_200_without_an_items_array (%j)",
  async (body) => {
    const deps = withFetch(async () => ({ status: 200, json: async () => body }));
    await expect(searchRepoByTitle("Some Paper Title", {}, deps)).rejects.toThrow(
      GitHubUnavailableError,
    );
  },
);

it("test_search_repo_rejects_a_malformed_body", async () => {
  const deps = withFetch(async () => ({
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
  }));
  await expect(searchRepoByTitle("Some Paper Title", {}, deps)).rejects.toThrow(
    GitHubUnavailableError,
  );
});

it("test_search_repo_accepts_a_200_with_an_empty_items_array", async () => {
  const deps = withFetch(async () => searchResp([]));
  expect(await searchRepoByTitle("Some Paper Title", {}, deps)).toBeNull();
});

it.each([{}, { message: "Not Found" }, { stargazers_count: null }, { stargazers_count: true }])(
  "test_fetch_repo_stars_rejects_a_200_without_a_star_count (%j)",
  async (body) => {
    const deps = withFetch(async () => ({ status: 200, json: async () => body }));
    await expect(fetchRepoStars("owner/repo", {}, deps)).rejects.toThrow(GitHubUnavailableError);
  },
);

it("test_fetch_repo_stars_accepts_a_genuine_zero", async () => {
  const deps = withFetch(async () => ({
    status: 200,
    json: async () => ({ stargazers_count: 0 }),
  }));
  expect(await fetchRepoStars("owner/repo", {}, deps)).toBe(0);
});

it.each([
  null,
  "a-string",
  {},
  { message: "rate limit" },
  { full_name: 7 },
  { full_name: "owner/repo", description: null },
  { full_name: "owner/repo", name: 123, description: null },
  { full_name: "owner/repo", name: null, description: "d" },
  { full_name: "owner/repo", name: "repo", description: { message: "x" } },
  { full_name: "owner/repo", name: "repo", description: ["d"] },
  { full_name: "owner/repo", name: "repo", description: 5 },
])("test_search_repo_rejects_a_malformed_item (%j)", async (item) => {
  const deps = withFetch(async () => searchResp([item]));
  await expect(searchRepoByTitle("Some Paper Title", {}, deps)).rejects.toThrow(
    GitHubUnavailableError,
  );
});

it("test_search_repo_still_returns_none_when_nothing_is_similar_enough", async () => {
  const deps = withFetch(async () =>
    searchResp([{ full_name: "someone/unrelated", name: "unrelated", description: "" }]),
  );
  expect(await searchRepoByTitle("Segment Anything", {}, deps)).toBeNull();
});

it.each([null, "", "A repo"])(
  "test_search_repo_accepts_a_string_or_null_description (%j)",
  async (description) => {
    const deps = withFetch(async () =>
      searchResp([{ full_name: "someone/unrelated", name: "unrelated", description }]),
    );
    expect(await searchRepoByTitle("Segment Anything", {}, deps)).toBeNull();
  },
);

// ---------- parse_github_repo_url ----------

describe("test_parse_github_repo_url_accepts_canonical", () => {
  it.each([
    ["https://github.com/owner/repo", ["owner", "repo"]],
    ["http://github.com/owner/repo", ["owner", "repo"]],
    ["https://www.github.com/owner/repo", ["owner", "repo"]],
    ["https://github.com/owner/repo.git", ["owner", "repo"]],
    ["https://github.com/owner/repo/tree/main", ["owner", "repo"]],
  ] as const)("%s", (url, expected) => {
    expect(parseGithubRepoUrl(url)).toEqual(expected);
  });
});

it.each([
  null,
  "",
  "not a url",
  "ftp://github.com/owner/repo",
  "ssh://git@github.com:owner/repo",
  "git@github.com:owner/repo",
  "https://example.com/owner/repo",
  "https://gitlab.com/owner/repo",
  "https://github.com.evil.com/owner/repo",
  "https://github.com/owner",
  "https://github.com/owner/repo with spaces",
  "https://github.com/$/repo",
  "https://github.com/owner/$",
])("test_parse_github_repo_url_rejects_invalid (%j)", (url) => {
  expect(parseGithubRepoUrl(url)).toBeNull();
});

it("test_parse_github_repo_url_strips_git_suffix", () => {
  expect(parseGithubRepoUrl("https://github.com/o/r.git")).toEqual(["o", "r"]);
});
