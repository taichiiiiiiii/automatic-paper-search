/**
 * Port of `paperpilot/tests/test_config_loader.py`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/collect/config/load.js";

let dir: string;
const ENV_KEYS = [
  "PAPERPILOT_GITHUB_TOKEN",
  "PAPERPILOT_S2_API_KEY",
  "PAPERPILOT_SLACK_WEBHOOK_URL",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-test-"));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function writeConfig(content: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

it("test_load_config_reads_yaml", () => {
  const cfg = writeConfig("search:\n  keywords: [llm, rag]\n  days_back: 5\n");
  const loaded = loadConfig(cfg);
  expect(loaded.search?.keywords).toEqual(["llm", "rag"]);
  expect(loaded.search?.days_back).toBe(5);
});

it("test_env_values_merged_into_config", () => {
  process.env.PAPERPILOT_GITHUB_TOKEN = "ghp_token123";
  process.env.PAPERPILOT_S2_API_KEY = "s2key";
  process.env.PAPERPILOT_SLACK_WEBHOOK_URL = "http://hook";
  const cfg = writeConfig("search: {}");
  const loaded = loadConfig(cfg);
  expect(loaded.env.githubToken).toBe("ghp_token123");
  expect(loaded.env.s2ApiKey).toBe("s2key");
  expect(loaded.env.slackWebhookUrl).toBe("http://hook");
});

it("test_env_none_when_not_set", () => {
  const cfg = writeConfig("search: {}");
  const loaded = loadConfig(cfg);
  expect(loaded.env.githubToken).toBeNull();
  expect(loaded.env.s2ApiKey).toBeNull();
  expect(loaded.env.slackWebhookUrl).toBeNull();
});

it("test_dotenv_file_next_to_config_is_loaded", () => {
  const cfg = writeConfig("search: {}");
  writeFileSync(join(dir, ".env"), "PAPERPILOT_GITHUB_TOKEN=dotenv_value\n");
  const loaded = loadConfig(cfg);
  expect(loaded.env.githubToken).toBe("dotenv_value");
});

it("test_missing_config_raises", () => {
  expect(() => loadConfig(join(dir, "nonexistent.yaml"))).toThrow();
});

it("test_empty_yaml_treated_as_empty_dict", () => {
  const cfg = writeConfig("");
  const loaded = loadConfig(cfg);
  expect(loaded.env).toBeDefined();
  expect(loaded.search).toBeUndefined();
});
