import {createHash} from "node:crypto";

import {Redacted, Schema} from "effect";

import {pagesGatewayModule} from "./pages-gateway.js";

const stageSchema = Schema.Struct({name: Schema.String, status: Schema.String});
const deploymentSchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  url: Schema.String,
  aliases: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  deployment_trigger: Schema.Struct({metadata: Schema.Struct({
    branch: Schema.String,
    commit_hash: Schema.optionalKey(Schema.String),
  })}),
  latest_stage: stageSchema,
});
const projectSchema = Schema.Struct({
  name: Schema.String,
  subdomain: Schema.String,
  production_branch: Schema.String,
  source: Schema.optionalKey(Schema.NullOr(Schema.Struct({type: Schema.String}))),
});

/** Non-secret identity and status returned by the Pages API. */
export type PagesDeployment = typeof deploymentSchema.Type;

/** The small set of project settings owned by the content gateway. */
export interface PagesGatewayConfiguration {
  readonly accountId: string;
  readonly applicationOrigin: string;
  readonly projectName: string;
  readonly workerName: string;
  readonly compatibilityDate: string;
}

/** Configuration for the account-scoped Pages control API. */
export interface PagesControlConfiguration {
  readonly accountId: string;
  readonly projectName: string;
  readonly apiToken: Redacted.Redacted;
  readonly apiOrigin?: string;
}

/** A sanitized control-plane failure, containing neither credentials nor API bodies. */
export class PagesControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PagesControlError";
  }
}

interface PagesGatewayEnvironmentSettings {
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
  readonly fail_open: boolean;
  readonly env_vars: Readonly<Record<string, {
    readonly type: "plain_text";
    readonly value: string;
  }>>;
  readonly services: Readonly<Record<string, {
    readonly service: string;
    readonly environment: string;
  }>>;
}

interface PagesProjectPatch {
  readonly deployment_configs: {
    readonly preview: PagesGatewayEnvironmentSettings;
    readonly production: PagesGatewayEnvironmentSettings;
  };
}

/** Manage only the configured Pages project; artifact input cannot select it. */
export class PagesControlClient {
  readonly #configuration: PagesControlConfiguration;
  readonly #projectPath: string;
  readonly #apiOrigin: string;

  constructor(configuration: PagesControlConfiguration) {
    if (!/^[a-f0-9]{32}$/.test(configuration.accountId)
      || !/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(configuration.projectName)) {
      throw new PagesControlError("The Pages account or project identity is invalid.");
    }
    this.#configuration = configuration;
    this.#projectPath = `/accounts/${configuration.accountId}/pages/projects/${configuration.projectName}`;
    this.#apiOrigin = configuration.apiOrigin ?? "https://api.cloudflare.com/client/v4";
  }

  async configureGateway(configuration: PagesGatewayConfiguration): Promise<void> {
    if (configuration.accountId !== this.#configuration.accountId
      || configuration.projectName !== this.#configuration.projectName) {
      throw new PagesControlError("The Pages gateway identity does not match its control client.");
    }
    const project = await this.#request("GET", "", undefined, projectSchema);
    if (project.name !== configuration.projectName
      || project.subdomain !== `${configuration.projectName}.pages.dev`
      || project.source !== null && project.source !== undefined) {
      throw new PagesControlError("The content gateway requires its configured Direct Upload project.");
    }
    const deploymentConfiguration: PagesGatewayEnvironmentSettings = {
      compatibility_date: configuration.compatibilityDate,
      compatibility_flags: [],
      fail_open: false,
      env_vars: {
        ARTIFACT_SERVER_CONTENT_DOMAIN: {type: "plain_text", value: project.subdomain},
        ARTIFACT_SERVER_ORIGIN: {type: "plain_text", value: configuration.applicationOrigin},
        ARTIFACT_SERVER_GATEWAY_REVISION: {type: "plain_text", value: pagesGatewayRevision()},
      },
      services: {
        ARTIFACT_SERVER: {service: configuration.workerName, environment: "production"},
      },
    };
    await this.#request("PATCH", "", {
      deployment_configs: {
        preview: deploymentConfiguration,
        production: deploymentConfiguration,
      },
    }, projectSchema);
  }

  async deployGateway(branch: string): Promise<PagesDeployment> {
    if (branch !== "gateway"
      && !/^(?:[a-f0-9]{36}|review-[a-f0-9]{56})$/.test(branch)) {
      throw new PagesControlError("The Pages gateway alias is invalid.");
    }
    const form = new FormData();
    form.set("branch", branch);
    form.set("commit_hash", pagesGatewayRevision());
    form.set("manifest", "{}");
    form.set("_worker.js", new Blob([pagesGatewayModule()], {type: "application/javascript+module"}), "_worker.js");
    return this.#request("POST", "/deployments", form, deploymentSchema);
  }

  async deployment(deploymentId: string): Promise<PagesDeployment> {
    if (!/^[a-f0-9-]{36}$/.test(deploymentId)) {
      throw new PagesControlError("The Pages deployment identity is invalid.");
    }
    return this.#request("GET", `/deployments/${deploymentId}`, undefined, deploymentSchema);
  }

  async #request<T>(
    method: "GET" | "PATCH" | "POST",
    path: string,
    body: FormData | PagesProjectPatch | undefined,
    schema: Schema.Codec<T, unknown>,
  ): Promise<T> {
    const headers = new Headers({
      Authorization: `Bearer ${Redacted.value(this.#configuration.apiToken)}`,
    });
    let requestBody: string | FormData | undefined;
    if (body instanceof FormData) {
      requestBody = body;
    } else if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    try {
      const options: RequestInit = {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      };
      if (requestBody !== undefined) options.body = requestBody;
      const response = await fetch(`${this.#apiOrigin}${this.#projectPath}${path}`, options);
      if (!response.ok) {
        await response.body?.cancel();
        throw new PagesControlError(`The Pages control request failed with HTTP ${response.status}.`);
      }
      const envelope = Schema.decodeUnknownSync(Schema.Struct({
        success: Schema.Literal(true),
        result: schema,
      }))(await response.json());
      return envelope.result;
    } catch (cause) {
      if (cause instanceof PagesControlError) throw cause;
      throw new PagesControlError("The Pages control request could not complete.");
    }
  }
}

/** Fingerprint both the deployed gateway and its readiness marker. */
export function pagesGatewayRevision(): string {
  return createHash("sha256").update(pagesGatewayModule()).digest("hex");
}
