import {Effect, type Redacted} from "effect";

import type {ContentIngress} from "../../../src/application/content-ingress.js";
import {ContentIngressUnavailable} from "../../../src/core/errors.js";
import {PagesControlClient, pagesGatewayRevision} from "./pages-control-client.js";

/** Provider configuration fixed by the installation, never by publication input. */
export interface PagesContentIngressConfiguration {
  readonly accountId: string;
  readonly projectName: string;
  readonly apiToken: Redacted.Redacted;
  /** Local HTTP boundaries used for provider qualification; never read from artifact input. */
  readonly apiOrigin?: string;
  readonly gatewayOrigin?: string;
}

const unavailable = () => new ContentIngressUnavailable({
  message: "The content address is not ready. Retry the request with the same idempotency key.",
});

/** Pages retains branch-to-deployment mappings across Worker restarts. */
export function createPagesContentIngress(configuration: PagesContentIngressConfiguration): ContentIngress {
  const client = new PagesControlClient(configuration);
  const revision = pagesGatewayRevision();
  const reachable = async (token: string): Promise<boolean> => {
    try {
      const origin = configuration.gatewayOrigin ?? `https://${token}.${configuration.projectName}.pages.dev`;
      const response = await fetch(new URL("/__artifact_server_gateway_ready", origin), {
        redirect: "error",
        headers: {"Cache-Control": "no-cache"},
        signal: AbortSignal.timeout(5_000),
      });
      const ready = response.status === 204 && response.headers.get("X-Artifact-Gateway-Revision") === revision;
      await response.body?.cancel();
      return ready;
    } catch {
      return false;
    }
  };
  return {
    ensureReady: Effect.fn("PagesContentIngress.ensureReady")(function* (token: string) {
      if (!/^(?:[a-f0-9]{36}|review-[a-f0-9]{56})$/.test(token)) {
        return yield* unavailable();
      }
      if (yield* Effect.promise(() => reachable(token))) return yield* Effect.void;
      let deployment = yield* Effect.tryPromise({
        try: () => client.deployGateway(token),
        catch: unavailable,
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (["failure", "canceled", "cancelled", "skipped"].includes(deployment.latest_stage.status)) {
          return yield* unavailable();
        }
        if (yield* Effect.promise(() => reachable(token))) return yield* Effect.void;
        yield* Effect.sleep("2 seconds");
        if (deployment.latest_stage.status !== "success") {
          deployment = yield* Effect.tryPromise({
            try: () => client.deployment(deployment.id),
            catch: unavailable,
          });
        }
      }
      return yield* unavailable();
    }, Effect.timeout("2 minutes"), Effect.mapError(unavailable)),
  };
}
