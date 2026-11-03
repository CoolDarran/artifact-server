import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  PagesControlClient,
  type PagesGatewayConfiguration,
} from "./pages-control-client.js";

interface PagesGatewayInstallation extends PagesGatewayConfiguration {
  readonly revision: string;
}

class PagesGatewayDeploymentError extends Schema.TaggedError<PagesGatewayDeploymentError>()(
  "PagesGatewayDeploymentError",
  {message: Schema.String},
) {}

/** Deploy gateway code only after its Pages project and application Worker exist. */
export const InstallPagesGateway = Alchemy.Action(
  "ArtifactServer.PagesGateway",
  Effect.gen(function* () {
    const credentials = yield* yield* Cloudflare.CloudflareEnvironment;
    if (credentials.type === "apiKey") {
      return yield* Effect.die(new Error("The Pages gateway requires a scoped Cloudflare API token."));
    }
    const apiToken = credentials.type === "apiToken"
      ? credentials.apiToken
      : credentials.accessToken;
    return Effect.fn("InstallPagesGateway")(function* (input: PagesGatewayInstallation) {
      const client = new PagesControlClient({
        accountId: input.accountId,
        projectName: input.projectName,
        apiToken,
      });
      yield* Effect.tryPromise({
        try: () => client.configureGateway(input),
        catch: () => new PagesGatewayDeploymentError({message: "The Pages gateway bindings could not be configured."}),
      });
      let deployment = yield* Effect.tryPromise({
        try: () => client.deployGateway("gateway"),
        catch: () => new PagesGatewayDeploymentError({message: "The Pages gateway upload failed."}),
      });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (deployment.latest_stage.name === "deploy" && deployment.latest_stage.status === "success") {
          return {
            projectName: input.projectName,
            deploymentId: deployment.id,
            revision: input.revision,
          };
        }
        if (["failure", "canceled", "cancelled", "skipped"].includes(deployment.latest_stage.status)) {
          return yield* new PagesGatewayDeploymentError({message: "Cloudflare rejected the Pages gateway deployment."});
        }
        yield* Effect.sleep("2 seconds");
        deployment = yield* Effect.tryPromise({
          try: () => client.deployment(deployment.id),
          catch: () => new PagesGatewayDeploymentError({message: "The Pages gateway deployment status could not be checked."}),
        });
      }
      return yield* new PagesGatewayDeploymentError({message: "The Pages gateway deployment did not finish within its readiness budget."});
    }, Effect.timeout("2 minutes"));
  }),
);
