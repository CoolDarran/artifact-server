import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";

import {Schema} from "effect";

const origin = process.env.ARTIFACT_SERVER_APPLICATION_ORIGIN;
const apiToken = process.env.ARTIFACT_SERVER_API_TOKEN;
if (origin !== "https://probe-artifacts.danran.one" || !apiToken) {
  throw new Error("Live Pages qualification requires its isolated application and API credential.");
}

const uploadSchema = Schema.Struct({
  commitUrl: Schema.String,
  files: Schema.Array(Schema.Struct({uploadUrl: Schema.String})),
});
const publicationSchema = Schema.Struct({
  artifact: Schema.Struct({id: Schema.String, projectId: Schema.String}),
  version: Schema.Struct({id: Schema.String}),
  links: Schema.Struct({version: Schema.String}),
});
const bootstrapSchema = Schema.Struct({bootstrapUrl: Schema.String});
const leaseSchema = Schema.Struct({baseUrl: Schema.String, versionId: Schema.String});
const headers = {Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json"};
const key = randomUUID();
const bytes = new TextEncoder().encode("<!doctype html><title>Pages live qualification</title><main>Immutable version bytes</main>");

async function requestApplication(path, options = {}) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, "API requests must stay on the configured application origin.");
  return fetch(url, {redirect: "error", signal: AbortSignal.timeout(180_000), ...options});
}

async function requestContent(path, options = {}) {
  const url = new URL(path);
  assert.equal(url.protocol, "https:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.ok(url.hostname.endsWith(".as-pages-runtime-probe.pages.dev"));
  return fetch(url, {redirect: "error", signal: AbortSignal.timeout(30_000), ...options});
}

async function expectStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: unexpected HTTP status`);
  await response.body?.cancel();
  console.log(`${label}: PASS`);
}

await Promise.all(["/health", "/ready"].map(async (path) => {
  await expectStatus(await requestApplication(path), 200, path);
}));
await expectStatus(await requestApplication("/api/v1/artifacts"), 401, "Unauthenticated API");

const plan = await requestApplication("/api/v1/uploads", {
  method: "POST", headers,
  body: JSON.stringify({entryPath: "index.html", files: [{
    path: "index.html", mediaType: "text/html; charset=utf-8",
    size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
  }]}),
});
assert.equal(plan.status, 201, "Staged upload creation");
const upload = Schema.decodeUnknownSync(uploadSchema)(await plan.json());
assert.equal(upload.files.length, 1);
await expectStatus(await requestApplication(upload.files[0].uploadUrl, {
  method: "PUT", headers: {Authorization: `Bearer ${apiToken}`}, body: bytes,
}), 200, "Staged file upload");

const command = {
  method: "POST", headers: {...headers, "Idempotency-Key": `pages-live-${key}`},
  body: JSON.stringify({target: {kind: "new_artifact", name: "Pages live qualification", accessSetting: "public_link"}}),
};
const commit = await requestApplication(upload.commitUrl, command);
assert.equal(commit.status, 201, "Publication waits for its live Pages address");
const published = Schema.decodeUnknownSync(publicationSchema)(await commit.json());
const replayResponse = await requestApplication(upload.commitUrl, command);
assert.equal(replayResponse.status, 200, "Publication replay");
const replay = Schema.decodeUnknownSync(publicationSchema)(await replayResponse.json());
assert.equal(replay.artifact.id, published.artifact.id);
assert.equal(replay.version.id, published.version.id);
const content = await requestContent(published.links.version);
assert.equal(content.status, 200, "Published content address");
assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
console.log("Exact version bytes and idempotent replay: PASS");

const artifactPath = `/api/v1/artifacts/${encodeURIComponent(published.artifact.id)}`;
await expectStatus(await requestApplication(`${artifactPath}/access`, {
  method: "PATCH", headers: {...headers, "Idempotency-Key": `pages-private-${key}`},
  body: JSON.stringify({accessSetting: "account_required", expectedCurrentVersionId: published.version.id}),
}), 200, "Public link disabled centrally");
await expectStatus(await requestContent(published.links.version), 401, "Private content denies anonymous requests");
const bootstrapResponse = await requestApplication(`${artifactPath}/content-sessions`, {method: "POST", headers});
assert.equal(bootstrapResponse.status, 201);
const bootstrap = Schema.decodeUnknownSync(bootstrapSchema)(await bootstrapResponse.json());
const exchange = await requestContent(bootstrap.bootstrapUrl);
assert.equal(exchange.status, 200);
assert.equal(exchange.headers.get("cache-control"), "private, no-store");
const setCookie = exchange.headers.get("set-cookie");
assert.ok(setCookie?.includes("Secure") && setCookie.includes("HttpOnly") && !setCookie.includes("Domain="));
const cookie = setCookie.split(";")[0];
await exchange.body?.cancel();
await expectStatus(await requestContent(published.links.version, {headers: {Cookie: cookie}}), 200, "Private content session");

const leaseResponse = await requestApplication(`${artifactPath}/versions/${encodeURIComponent(published.version.id)}/preview-leases`, {method: "POST", headers});
assert.equal(leaseResponse.status, 201);
const lease = Schema.decodeUnknownSync(leaseSchema)(await leaseResponse.json());
assert.equal(lease.versionId, published.version.id);
const preview = await requestContent(lease.baseUrl);
assert.equal(preview.status, 200, "Review lease address");
assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), bytes);
console.log("Private bootstrap and exact-version Review lease: PASS");

await expectStatus(await requestContent(new URL("/api/v1/artifacts", published.links.version)), 404, "Content host isolates application API");
console.log("Live Pages runtime qualification passed. Browser login and iframe behavior require separate browser qualification.");
