// Dormant deployment wrapper. It is intentionally not exported from index.ts
// and has no Wrangler binding or migration until the activation gate is met.

import { DurableObject } from "cloudflare:workers";
import { PaperSlideDurableCoordinatorService } from "./paper-slide-durable-coordinator.js";

export class PaperSlideDurableCoordinator extends DurableObject {
  readonly #service: PaperSlideDurableCoordinatorService;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#service = new PaperSlideDurableCoordinatorService(ctx, env);
  }

  fetch(request: Request): Promise<Response> {
    return this.#service.fetch(request);
  }
}
