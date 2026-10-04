/**
 * Load YAML config + .env into a single object — TS port of
 * `paperpilot/utils/config_loader.py::load_config` (COL-35 of
 * docs/migration/safety-contracts.md).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadEnv } from "./env.js";
import type { Config } from "./types.js";

/** Thrown when `configPath` does not exist — mirrors Python's `FileNotFoundError`. */
export class ConfigNotFoundError extends Error {
  constructor(configPath: string) {
    super(`Config file not found: ${configPath}`);
    this.name = "FileNotFoundError";
  }
}

/** Loads YAML config, then merges environment variables under `config.env`. */
export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;

  const envPath = join(dirname(configPath), ".env");
  const config = parsed as Config;
  config.env = loadEnv(existsSync(envPath) ? envPath : null);
  return config;
}
