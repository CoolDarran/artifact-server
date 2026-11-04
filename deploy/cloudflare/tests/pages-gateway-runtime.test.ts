import {createHash} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {request} from "node:https";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {Schema} from "effect";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {CLOUDFLARE_COMPATIBILITY_DATE} from "../src/deployment-input.js";
import {pagesGatewayRevision} from "../src/pages-control-client.js";
import {pagesGatewayModule} from "../src/pages-gateway.js";

const applicationOrigin = "https://artifacts.example.test";
const contentDomain = "content-test.example.test";
const apiToken = "pages-runtime-test-credential-with-sufficient-length";
const bytes = new TextEncoder().encode("<h1>Immutable Pages content</h1>");
const uploadSchema = Schema.Struct({
  commitUrl: Schema.String,
  files: Schema.Array(Schema.Struct({uploadUrl: Schema.String})),
});
const publicationSchema = Schema.Struct({links: Schema.Struct({version: Schema.String})});
const headers = {Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json"};
let directory: string;
let application: Unstable_DevWorker | undefined;
let gateway: Unstable_DevWorker | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "artifact-pages-runtime-"));
  const applicationName = `pages-app-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
  const applicationConfiguration = join(directory, "application.json");
  await writeFile(applicationConfiguration, JSON.stringify({
    name: applicationName,
    main: new URL("../src/worker.ts", import.meta.url).pathname,
    compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE,
  }));
  application = await unstable_dev(new URL("../src/worker.ts", import.meta.url).pathname, {
    config: applicationConfiguration,
    compatibilityFlags: ["nodejs_compat"],
    assets: new URL("../../../dist/web", import.meta.url).pathname,
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: join(directory, "state"),
    experimental: {
      d1Databases: [{binding: "ARTIFACT_SERVER_D1_DATABASE", database_id: applicationName, database_name: applicationName}],
      disableExperimentalWarning: true,
      watch: false,
    },
    r2: [{binding: "ARTIFACT_SERVER_R2_BUCKET", bucket_name: applicationName}],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: applicationName,
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "pages-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: applicationOrigin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
  const gatewayPath = join(directory, "gateway.mjs");
  await writeFile(gatewayPath, pagesGatewayModule());
  gateway = await unstable_dev(gatewayPath, {
    compatibilityDate: CLOUDFLARE_COMPATIBILITY_DATE,
    experimental: {disableExperimentalWarning: true, watch: false},
    inspect: false,
    local: true,
    logLevel: "error",
    services: [{binding: "ARTIFACT_SERVER", service: applicationName}],
    localProtocol: "https",
    vars: {
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_ORIGIN: applicationOrigin,
      ARTIFACT_SERVER_GATEWAY_REVISION: pagesGatewayRevision(),
    },
  });
}, 45_000);

afterAll(async () => {
  await gateway?.stop();
  await application?.stop();
  if (directory !== undefined) await rm(directory, {recursive: true, force: true});
});

async function publish(accessSetting: "public_link" | "account_required"): Promise<string> {
  if (application === undefined) throw new Error("The real application Worker did not start.");
  const create = await application.fetch(`${applicationOrigin}/api/v1/uploads`, {
    method: "POST",
    headers,
    body: JSON.stringify({entryPath: "index.html", files: [{
      path: "index.html", mediaType: "text/html", size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }]}),
  });
  expect(create.status).toBe(201);
  const upload = Schema.decodeUnknownSync(uploadSchema)(await create.json());
  const file = upload.files[0];
  if (file === undefined) throw new Error("The upload did not contain its planned file.");
  const stored = await application.fetch(file.uploadUrl, {method: "PUT", headers, body: bytes});
  expect(stored.status).toBe(200);
  const committed = await application.fetch(upload.commitUrl, {
    method: "POST",
    headers: {...headers, "Idempotency-Key": `pages-gateway-${accessSetting}`},
    body: JSON.stringify({target: {kind: "new_artifact", name: `Pages ${accessSetting}`, tags: [], accessSetting}}),
  });
  expect(committed.status).toBe(201);
  return Schema.decodeUnknownSync(publicationSchema)(await committed.json()).links.version;
}

async function gatewayFetch(input: string | URL, options: {method?: string; headers?: Record<string, string>} = {}): Promise<Response> {
  if (gateway === undefined) throw new Error("The Pages gateway Worker did not start.");
  const url = new URL(input);
  const port = gateway.port;
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers: {...options.headers, Host: url.host},
      // Wrangler generates a development certificate for this loopback server.
      rejectUnauthorized: false,
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = incoming.statusCode ?? 500;
        const body = options.method === "HEAD" || [204, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks));
        resolve(new Response(body, {status, headers: responseHeaders}));
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("Pages gateway with real application, D1, R2, and service binding", () => {
  it("preserves immutable public bytes, paths, HEAD, and range delivery", async () => {
    const link = await publish("public_link");
    const response = await gatewayFetch(link);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const head = await gatewayFetch(link, {method: "HEAD"});
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const range = await gatewayFetch(link, {headers: {Range: "bytes=0-3"}});
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("<h1>");
    const missing = await gatewayFetch(new URL("missing.js", link));
    expect(missing.status).toBe(404);
  });

  it("keeps account-required content private when reached through Pages", async () => {
    const link = await publish("account_required");
    const response = await gatewayFetch(link, {method: "GET"});
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("Immutable Pages content");
  });

  it("rejects the project root, deployment hashes, other domains, and extra host labels", async () => {
    const hosts = [contentDomain, `12345678.${contentDomain}`, `a.${"a".repeat(36)}.${contentDomain}`, "attacker.example.test"];
    const responses = await Promise.all(hosts.map(host => gatewayFetch(`https://${host}/`)));
    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404]);
    expect(responses.every(response => response.headers.get("Cache-Control") === "no-store")).toBe(true);
  });

  it("reports gateway readiness only through its bound healthy application", async () => {
    const ready = await gatewayFetch(`https://${"f".repeat(36)}.${contentDomain}/__artifact_server_gateway_ready`);
    expect(ready.status).toBe(204);
    expect(ready.headers.get("X-Artifact-Gateway-Revision")).toBe(pagesGatewayRevision());
    expect(ready.headers.get("Cache-Control")).toBe("no-store");
    const unknown = await gatewayFetch(`https://${"f".repeat(36)}.${contentDomain}/`);
    expect(unknown.status).toBe(404);
  });
});
