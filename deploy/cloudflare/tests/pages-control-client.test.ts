import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {once} from "node:events";

import {Redacted, Schema} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {
  PagesControlClient,
  pagesGatewayRevision,
} from "../src/pages-control-client.js";
import {pagesGatewayModule} from "../src/pages-gateway.js";

const accountId = "a".repeat(32);
const projectName = "content-test";
const deploymentId = "01234567-89ab-cdef-0123-456789abcdef";
const project = {name: projectName, subdomain: `${projectName}.pages.dev`, production_branch: "main", source: null};
const projectPath = `/accounts/${accountId}/pages/projects/${projectName}`;
const credential = "test-only-pages-credential";
const requests: {method: string; path: string; authorization: string; body: Buffer; contentType: string}[] = [];
let failureStatus: number | undefined;
let malformedResponse: boolean;
let gitProject: boolean;
let client: PagesControlClient;
let api = createServer();

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({
    method: request.method ?? "",
    path: request.url ?? "",
    authorization: request.headers.authorization ?? "",
    contentType: request.headers["content-type"] ?? "",
    body: Buffer.concat(chunks),
  });
  response.setHeader("Content-Type", "application/json");
  if (failureStatus !== undefined) {
    response.statusCode = failureStatus;
    response.end(JSON.stringify({errors: [{message: credential}]}));
    return;
  }
  if (malformedResponse) {
    response.end(JSON.stringify({success: true, result: {credential}}));
    return;
  }
  const result = request.url === projectPath
    ? {...project, source: gitProject ? {type: "github"} : null}
    : {
      id: deploymentId,
      url: `https://12345678.${projectName}.pages.dev`,
      aliases: [`https://${"a".repeat(36)}.${projectName}.pages.dev`],
      deployment_trigger: {metadata: {branch: "a".repeat(36), commit_hash: pagesGatewayRevision()}},
      latest_stage: {name: "deploy", status: "success"},
    };
  response.end(JSON.stringify({success: true, result}));
}

beforeEach(async () => {
  requests.length = 0;
  failureStatus = undefined;
  malformedResponse = false;
  gitProject = false;
  api = createServer((request, response) => {
    void respond(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = Schema.decodeUnknownSync(Schema.Struct({port: Schema.Number}))(api.address());
  client = new PagesControlClient({
    accountId,
    projectName,
    apiToken: Redacted.make(credential),
    apiOrigin: `http://127.0.0.1:${address.port}`,
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    api.close(error => error === undefined ? resolve() : reject(error));
    api.closeAllConnections();
  });
});

describe("Pages content control API", () => {
  it("configures both environments with the same application binding and closed failure policy", async () => {
    await client.configureGateway({
      accountId,
      projectName,
      applicationOrigin: "https://artifacts.example.com",
      workerName: "artifact-server-test",
      compatibilityDate: "2026-10-01",
    });
    expect(requests.map(request => [request.method, request.path])).toEqual([
      ["GET", projectPath], ["PATCH", projectPath],
    ]);
    const patch: unknown = JSON.parse(requests[1]?.body.toString() ?? "null");
    const expected = {
      compatibility_date: "2026-10-01",
      compatibility_flags: [],
      fail_open: false,
      env_vars: {
        ARTIFACT_SERVER_CONTENT_DOMAIN: {type: "plain_text", value: `${projectName}.pages.dev`},
        ARTIFACT_SERVER_ORIGIN: {type: "plain_text", value: "https://artifacts.example.com"},
        ARTIFACT_SERVER_GATEWAY_REVISION: {type: "plain_text", value: pagesGatewayRevision()},
      },
      services: {ARTIFACT_SERVER: {service: "artifact-server-test", environment: "production"}},
    };
    expect(patch).toEqual({deployment_configs: {preview: expected, production: expected}});
    expect(requests.every(request => request.authorization === `Bearer ${credential}`)).toBe(true);
    expect(JSON.stringify(patch)).not.toContain(credential);
  });

  it("uploads only the gateway module, never artifact bytes, under its exact content alias", async () => {
    const branch = "a".repeat(36);
    const deployment = await client.deployGateway(branch);
    const upload = requests[0];
    if (upload === undefined) throw new Error("The gateway upload did not reach the HTTP boundary.");
    const form = await new Response(new Uint8Array(upload.body), {
      headers: {"Content-Type": upload.contentType},
    }).formData();
    const module = form.get("_worker.js");
    if (!(module instanceof File)) throw new Error("The gateway module is not an uploaded file.");
    expect(upload.path).toBe(`${projectPath}/deployments`);
    expect(form.get("branch")).toBe(branch);
    expect(form.get("manifest")).toBe("{}");
    expect(form.get("commit_hash")).toBe(pagesGatewayRevision());
    expect(module.type).toBe("application/javascript+module");
    expect(await module.text()).toBe(pagesGatewayModule());
    expect([...form.keys()].toSorted()).toEqual(["_worker.js", "branch", "commit_hash", "manifest"]);
    expect(deployment.latest_stage.status).toBe("success");
  });

  it("rejects a Git-connected project before changing any configuration", async () => {
    gitProject = true;
    await expect(client.configureGateway({
      accountId,
      projectName,
      applicationOrigin: "https://artifacts.example.com",
      workerName: "artifact-server-test",
      compatibilityDate: "2026-10-01",
    })).rejects.toThrow("Direct Upload project");
    expect(requests.map(request => request.method)).toEqual(["GET"]);
  });

  it("rejects untrusted aliases and deployment identifiers before a control request", async () => {
    await Promise.all(["main", "../other-project", "a.b", "a".repeat(35)].map(alias =>
      expect(client.deployGateway(alias)).rejects.toThrow("alias is invalid")
    ));
    await expect(client.deployment("../../other-project")).rejects.toThrow("identity is invalid");
    expect(requests).toHaveLength(0);
  });

  it("keeps credentials and provider error bodies out of failures", async () => {
    failureStatus = 403;
    await expect(client.deployment(deploymentId)).rejects.toThrow("HTTP 403");
    await expect(client.deployment(deploymentId)).rejects.not.toThrow(credential);
    failureStatus = undefined;
    malformedResponse = true;
    await expect(client.deployment(deploymentId)).rejects.toThrow("could not complete");
    await expect(client.deployment(deploymentId)).rejects.not.toThrow(credential);
  });
});
