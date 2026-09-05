// Dormant production composition for the Paper Slide request plane.
//
// This module deliberately owns no Worker route or binding names. A future
// entrypoint may pass an explicitly projected environment into the returned
// factory, but importing this file alone cannot enable the public API.

import { createPaperSlideApi } from "./paper-slide-api.js";
import {
  PAPER_SLIDE_CATALOG_PIN_SCHEMA,
  createPaperSlideCatalogAdapter,
} from "./paper-slide-catalog.js";
import {
  PAPER_SLIDE_WORKFLOW_FILE,
  createPaperSlideDispatchAdapter,
} from "./paper-slide-dispatch.js";
import {
  PAPER_SLIDE_DURABLE_COORDINATOR_NAME,
  createPaperSlideDurableCoordinatorClient,
  isPaperSlideDurableJobId,
} from "./paper-slide-durable-coordinator.js";
import { createPaperSlideWorkflowApi } from "./paper-slide-workflow-api.js";

const FACTORY_KEYS = Object.freeze(["config", "dependencies"]);
const CONFIG_KEYS = Object.freeze([
  "allowedOrigins",
  "catalogPin",
  "githubOwner",
  "githubRef",
  "githubRepo",
  "githubWorkflow",
]);
const DEPENDENCY_KEYS = Object.freeze(["fetch", "now", "randomBytes"]);
const ENVIRONMENT_KEYS = Object.freeze([
  "catalogBinding",
  "coordinatorNamespace",
  "coordinatorUpdateToken",
  "githubToken",
]);
const PIN_KEYS = Object.freeze([
  "manifest_key",
  "manifest_sha256",
  "records_prefix",
  "schema_version",
  "snapshot_version",
]);
const WORKFLOW_FACTORY_KEYS = Object.freeze(["dependencies"]);
const WORKFLOW_DEPENDENCY_KEYS = Object.freeze(["now"]);
const WORKFLOW_ENVIRONMENT_KEYS = Object.freeze([
  "coordinatorNamespace",
  "coordinatorUpdateToken",
  "workflowAuthorizationSecret",
]);

function projectExactOwnData(value, keys, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(message);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError(message);
  const sorted = ownKeys.slice().sort();
  if (sorted.length !== keys.length || !sorted.every((key, index) => key === keys[index])) {
    throw new TypeError(message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(message);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function projectAllowedOrigins(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Paper Slide runtime origins are invalid");
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  expectedKeys.push("length");
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => ownKeys.includes(key))
  ) {
    throw new TypeError("Paper Slide runtime origins are invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("Paper Slide runtime origins are invalid");
    }
    const origin = descriptor.value;
    if (typeof origin !== "string" || seen.has(origin)) {
      throw new TypeError("Paper Slide runtime origins are invalid");
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError("Paper Slide runtime origins are invalid");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== origin ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new TypeError("Paper Slide runtime origins are invalid");
    }
    seen.add(origin);
    result.push(origin);
  }
  return Object.freeze(result);
}

function projectConfig(value) {
  const config = projectExactOwnData(value, CONFIG_KEYS, "Paper Slide runtime config is invalid");
  const pin = projectExactOwnData(
    config.catalogPin,
    PIN_KEYS,
    "Paper Slide runtime catalog pin is invalid",
  );
  if (pin.schema_version !== PAPER_SLIDE_CATALOG_PIN_SCHEMA) {
    throw new TypeError("Paper Slide runtime catalog pin is invalid");
  }
  if (config.githubWorkflow !== PAPER_SLIDE_WORKFLOW_FILE) {
    throw new TypeError("Paper Slide runtime workflow is invalid");
  }
  return Object.freeze({
    allowedOrigins: projectAllowedOrigins(config.allowedOrigins),
    catalogPin: pin,
    githubOwner: config.githubOwner,
    githubRef: config.githubRef,
    githubRepo: config.githubRepo,
    githubWorkflow: config.githubWorkflow,
  });
}

function projectDependencies(value) {
  const dependencies = projectExactOwnData(
    value,
    DEPENDENCY_KEYS,
    "Paper Slide runtime dependencies are invalid",
  );
  if (
    typeof dependencies.fetch !== "function" ||
    typeof dependencies.now !== "function" ||
    typeof dependencies.randomBytes !== "function"
  ) {
    throw new TypeError("Paper Slide runtime dependencies are invalid");
  }
  return dependencies;
}

// Returns a factory for an explicit Paper Slide-only environment projection.
// The caller must construct that projection from Worker bindings; passing the
// complete Worker environment is intentionally rejected.
export function createPaperSlideRuntimeFactory(options) {
  const projected = projectExactOwnData(
    options,
    FACTORY_KEYS,
    "Paper Slide runtime factory options are invalid",
  );
  const config = projectConfig(projected.config);
  const dependencies = projectDependencies(projected.dependencies);

  return function createPaperSlideRuntime(environment) {
    const env = projectExactOwnData(
      environment,
      ENVIRONMENT_KEYS,
      "Paper Slide runtime environment is invalid",
    );
    const catalog = createPaperSlideCatalogAdapter({
      binding: env.catalogBinding,
      pin: config.catalogPin,
    });
    const coordinator = createPaperSlideDurableCoordinatorClient({
      namespace: env.coordinatorNamespace,
      updateToken: env.coordinatorUpdateToken,
      objectName: PAPER_SLIDE_DURABLE_COORDINATOR_NAME,
    });
    const dispatcher = createPaperSlideDispatchAdapter({
      fetch: dependencies.fetch,
      token: env.githubToken,
      owner: config.githubOwner,
      repo: config.githubRepo,
      ref: config.githubRef,
      workflow: config.githubWorkflow,
      validateJobId: isPaperSlideDurableJobId,
    });
    return createPaperSlideApi({
      allowedOrigins: config.allowedOrigins,
      catalog,
      coordinator,
      dispatcher,
      randomBytes: dependencies.randomBytes,
      now: dependencies.now,
    });
  };
}

// Independent composition for the authenticated workflow callback plane. Its
// closed environment intentionally cannot be passed to the public factory (or
// vice versa), and its authorization secret never enters the public API.
export function createPaperSlideWorkflowRuntimeFactory(options) {
  const projected = projectExactOwnData(
    options,
    WORKFLOW_FACTORY_KEYS,
    "Paper Slide workflow runtime factory options are invalid",
  );
  const dependencies = projectExactOwnData(
    projected.dependencies,
    WORKFLOW_DEPENDENCY_KEYS,
    "Paper Slide workflow runtime dependencies are invalid",
  );
  if (typeof dependencies.now !== "function") {
    throw new TypeError("Paper Slide workflow runtime dependencies are invalid");
  }

  return function createPaperSlideWorkflowRuntime(environment) {
    const env = projectExactOwnData(
      environment,
      WORKFLOW_ENVIRONMENT_KEYS,
      "Paper Slide workflow runtime environment is invalid",
    );
    const coordinator = createPaperSlideDurableCoordinatorClient({
      namespace: env.coordinatorNamespace,
      updateToken: env.coordinatorUpdateToken,
      objectName: PAPER_SLIDE_DURABLE_COORDINATOR_NAME,
    });
    return createPaperSlideWorkflowApi({
      authorizationSecret: env.workflowAuthorizationSecret,
      coordinator,
      now: dependencies.now,
    });
  };
}
