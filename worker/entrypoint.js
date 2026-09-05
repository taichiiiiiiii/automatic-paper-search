const PAPER_SLIDE_PATHS = new Set([
  "/api/paper-slides",
  "/api/paper-slides/status",
]);
const PAPER_SLIDE_WORKFLOW_PATHS = new Set([
  "/api/paper-slides/internal/claim",
  "/api/paper-slides/internal/status",
]);
const WORKER_CONFIG_KEYS = new Set([
  "handleThemePost",
  "handleThemeStatusGet",
  "paperSlideApi",
  "paperSlideApiFactory",
  "paperSlideWorkflowApi",
  "paperSlideWorkflowApiFactory",
]);

function projectWorkerConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !WORKER_CONFIG_KEYS.has(key))) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const projected = {};
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
    projected[key] = descriptor.value;
  }
  return projected;
}

function ownAdapterMethod(value, methodName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, methodName);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true ||
      typeof descriptor.value !== "function") {
    return null;
  }
  return descriptor.value;
}

function notFound() {
  return new Response("Not Found", { status: 404 });
}

function serviceUnavailable() {
  return new Response("Service Unavailable", {
    status: 503,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function invokeAdapter(receiver, method, request) {
  try {
    const response = await method.call(receiver, request);
    return response instanceof Response ? response : serviceUnavailable();
  } catch {
    return serviceUnavailable();
  }
}

function themePreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

// Keep entrypoint selection independently testable under Node. Paper Slide is
// deliberately opt-in: the production Worker omits paperSlideApi until durable
// catalog, storage, and dispatch adapters are approved and configured.
export function createPaperPilotWorker(config = {}) {
  const projected = projectWorkerConfig(config);
  if (projected === null) throw new TypeError("Worker configuration is invalid");
  const {
    handleThemePost,
    handleThemeStatusGet,
    paperSlideApi = undefined,
    paperSlideApiFactory = undefined,
    paperSlideWorkflowApi = undefined,
    paperSlideWorkflowApiFactory = undefined,
  } = projected;
  if (typeof handleThemePost !== "function" || typeof handleThemeStatusGet !== "function") {
    throw new TypeError("theme request handlers are required");
  }
  const paperSlideHandle = paperSlideApi === undefined
    ? undefined
    : ownAdapterMethod(paperSlideApi, "handle");
  if (paperSlideApi !== undefined && paperSlideHandle === null) {
    throw new TypeError("Paper Slide API adapter is invalid");
  }
  if (paperSlideApiFactory !== undefined && typeof paperSlideApiFactory !== "function") {
    throw new TypeError("Paper Slide API factory is invalid");
  }
  if (paperSlideApi !== undefined && paperSlideApiFactory !== undefined) {
    throw new TypeError("Paper Slide API adapter and factory are mutually exclusive");
  }
  const paperSlideWorkflowFetch = paperSlideWorkflowApi === undefined
    ? undefined
    : ownAdapterMethod(paperSlideWorkflowApi, "fetch");
  if (paperSlideWorkflowApi !== undefined && paperSlideWorkflowFetch === null) {
    throw new TypeError("Paper Slide workflow API adapter is invalid");
  }
  if (paperSlideWorkflowApiFactory !== undefined &&
      typeof paperSlideWorkflowApiFactory !== "function") {
    throw new TypeError("Paper Slide workflow API factory is invalid");
  }
  if (paperSlideWorkflowApi !== undefined && paperSlideWorkflowApiFactory !== undefined) {
    throw new TypeError("Paper Slide workflow API adapter and factory are mutually exclusive");
  }

  return Object.freeze({
    async fetch(request, env, executionContext) {
      const url = new URL(request.url);

      if (PAPER_SLIDE_WORKFLOW_PATHS.has(url.pathname)) {
        let resolvedApi = paperSlideWorkflowApi;
        let resolvedFetch = paperSlideWorkflowFetch;
        if (paperSlideWorkflowApiFactory !== undefined) {
          try {
            resolvedApi = await paperSlideWorkflowApiFactory(env, executionContext);
            if (resolvedApi === undefined) return notFound();
            resolvedFetch = ownAdapterMethod(resolvedApi, "fetch");
            if (resolvedFetch === null) return serviceUnavailable();
          } catch {
            return serviceUnavailable();
          }
        }
        if (resolvedApi === undefined) return notFound();
        return invokeAdapter(resolvedApi, resolvedFetch, request);
      }
      if (PAPER_SLIDE_PATHS.has(url.pathname)) {
        let resolvedApi = paperSlideApi;
        let resolvedHandle = paperSlideHandle;
        if (paperSlideApiFactory !== undefined) {
          try {
            resolvedApi = await paperSlideApiFactory(env, executionContext);
            if (resolvedApi === undefined) return notFound();
            resolvedHandle = ownAdapterMethod(resolvedApi, "handle");
            if (resolvedHandle === null) return serviceUnavailable();
          } catch {
            return serviceUnavailable();
          }
        }
        if (resolvedApi === undefined) return notFound();
        return invokeAdapter(resolvedApi, resolvedHandle, request);
      }
      if (url.pathname.startsWith("/api/paper-slides")) return notFound();
      if (url.pathname === "/api/themes" && request.method === "POST") {
        return handleThemePost(request, env);
      }
      if (url.pathname === "/api/themes/status" && request.method === "GET") {
        return handleThemeStatusGet(request, env);
      }
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return themePreflight();
      }
      return notFound();
    },
  });
}
