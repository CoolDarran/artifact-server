import {createServer, type Server} from "node:http";

import {Effect, Redacted, Schema} from "effect";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";

import {createPagesContentIngress} from "../src/pages-content-ingress.js";
import {pagesGatewayRevision} from "../src/pages-control-client.js";

const accountId = "a".repeat(32);
const token = "b".repeat(36);
const deploymentId = "11111111-2222-3333-4444-555555555555";
let api: Server;
let origin: string;
let ready: boolean;
let revision: string;
let rejectDeployment: boolean;
let requests: number;
let uploads: number;
let uploadedBody: string;

beforeAll(async () => {
  api = createServer(async (request, response) => {
    requests += 1;
    if (request.url === "/__artifact_server_gateway_ready") {
      response.writeHead(ready ? 204 : 404, {"X-Artifact-Gateway-Revision": revision});
      response.end();
      return;
    }
    if (request.url !== `/accounts/${accountId}/pages/projects/content-test/deployments` || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    uploadedBody = Buffer.concat(chunks).toString();
    uploads += 1;
    ready = !rejectDeployment;
    revision = pagesGatewayRevision();
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({success: true, result: {
      id: deploymentId,
      url: "https://12345678.content-test.pages.dev",
      latest_stage: {name: "deploy", status: rejectDeployment ? "failure" : "success"},
      deployment_trigger: {metadata: {branch: token}},
    }}));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = Schema.decodeUnknownSync(Schema.Struct({port: Schema.Number}))(api.address());
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  ready = false;
  revision = pagesGatewayRevision();
  rejectDeployment = false;
  requests = 0;
  uploads = 0;
  uploadedBody = "";
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => api.close(error => error === undefined ? resolve() : reject(error)));
});

function ingress() {
  return createPagesContentIngress({
    accountId,
    projectName: "content-test",
    apiToken: Redacted.make("fixture-secret"),
    apiOrigin: origin,
    gatewayOrigin: origin,
  });
}

describe("Pages hostname readiness through a real HTTP control and gateway boundary", () => {
  it("waits for a successful gateway and reuses its durable alias after provider reconstruction", async () => {
    await Effect.runPromise(ingress().ensureReady(token));
    await Effect.runPromise(ingress().ensureReady(token));
    expect(uploads).toBe(1);
    expect(uploadedBody).toContain(token);
    expect(ready).toBe(true);
  });

  it("fails closed on a rejected deployment without exposing the control token", async () => {
    rejectDeployment = true;
    await expect(Effect.runPromise(ingress().ensureReady(token))).rejects.toThrow("content address is not ready");
    expect(ready).toBe(false);
    expect(uploads).toBe(1);
  });

  it("refreshes a reachable alias that still runs an older gateway", async () => {
    ready = true;
    revision = "obsolete-gateway";
    await Effect.runPromise(ingress().ensureReady(token));
    expect(uploads).toBe(1);
    expect(revision).toBe(pagesGatewayRevision());
  });

  it("rejects untrusted hostname selectors before any HTTP operation", async () => {
    await Promise.all(["../other-project", "main", `${token}.attacker.test`].map(input =>
      expect(Effect.runPromise(ingress().ensureReady(input))).rejects.toThrow("content address is not ready")
    ));
    expect(requests).toBe(0);
  });
});
