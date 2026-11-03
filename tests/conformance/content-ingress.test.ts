import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Deferred, Effect, ManagedRuntime, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {ContentAccessService} from "../../src/application/content-access.js";
import {StagedUploadService, type CommitStagedUploadCommand} from "../../src/application/staged-upload.js";
import {ContentIngressUnavailable} from "../../src/core/errors.js";
import {membershipRoles, principalCapabilities, principalKinds, type Principal} from "../../src/core/identity.js";
import {SystemClock, SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const principal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [principalCapabilities.createArtifact, principalCapabilities.issueContentSession, principalCapabilities.publishAnyArtifact],
  displayName: "Content ingress fixture",
  id: "ingress-service-principal",
  installationId: "ingress-test",
  kind: principalKinds.service,
  membershipRole: membershipRoles.member,
};
let directory: string;
let repository: SqliteArtifactRepository;
let identityRepository: SqliteIdentityRepository;
let runtime: ApplicationRuntime;
let unavailable: boolean;
let pause: Deferred.Deferred<void> | null;
let entered: Deferred.Deferred<void>;
let ready: Set<string>;

function openRuntime(): ApplicationRuntime {
  const database = path.join(directory, "artifact-server.db");
  repository = new SqliteArtifactRepository(database);
  identityRepository = new SqliteIdentityRepository(database);
  return ManagedRuntime.make(createLocalApplicationLayer({
    apiToken: Redacted.make("ingress-test-credential"),
    blobs: new LocalBlobStore(path.join(directory, "blobs")),
    bootstrapAdministratorEmail: "admin@example.test",
    clock: new SystemClock(),
    contentIngress: {ensureReady: token => Effect.gen(function* () {
      if (unavailable) return yield* new ContentIngressUnavailable({message: "The content address is unavailable."});
      if (pause !== null) {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(pause);
      }
      ready.add(token);
      return yield* Effect.void;
    })},
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: principal.installationId,
    interactiveIdentityProvider: null,
    localBootstrapCredential: null,
    protectBootstrapAdministrator: false,
    repository,
    staging: new LocalStagingStore(path.join(directory, "staging")),
  }));
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "artifact-content-ingress-"));
  unavailable = false;
  pause = null;
  entered = await Effect.runPromise(Deferred.make<void>());
  ready = new Set();
  runtime = openRuntime();
  await runtime.context();
});

afterEach(async () => {
  if (pause !== null) await Effect.runPromise(Deferred.succeed(pause, undefined));
  await runtime.dispose();
  identityRepository.close();
  repository.close();
  await rm(directory, {recursive: true, force: true});
});

async function prepare(content: string, key: string, target: CommitStagedUploadCommand["target"]): Promise<CommitStagedUploadCommand> {
  const bytes = new TextEncoder().encode(content);
  const upload = await runtime.runPromise(StagedUploadService.use(service => service.createUpload({
    entryPath: "index.html",
    files: [{path: "index.html", size: bytes.byteLength, mediaType: "text/html", sha256: createHash("sha256").update(bytes).digest("hex")}],
    principal,
    projectId: null,
  })));
  const file = upload.files[0];
  if (file === undefined) throw new Error("The planned upload is missing its entry file.");
  await runtime.runPromise(StagedUploadService.use(service => service.uploadFile({
    body: new Blob([bytes]).stream(),
    principal,
    projectId: null,
    storageToken: file.storageToken,
    uploadId: upload.id,
  })));
  return {idempotencyKey: `content-address-${key}`, principal, projectId: null, target, uploadId: upload.id};
}

function commit(command: CommitStagedUploadCommand) {
  return StagedUploadService.use(service => service.commitUpload(command));
}

const newArtifact = {kind: "new_artifact", name: "Ingress fixture", accessSetting: "public_link"} as const;

describe("publication and Review content ingress", () => {
  test("PUB-005-F: a failed address leaves the upload retryable and preserves the committed identity across restart", async () => {
    const command = await prepare("<h1>Original bytes</h1>", "ingress-retry", newArtifact);
    unavailable = true;
    const failed = await runtime.runPromise(Effect.result(commit(command)));
    expect(failed).toMatchObject({failure: {_tag: "ContentIngressUnavailable"}});
    unavailable = false;
    const published = await runtime.runPromise(commit(command));
    expect(ready.has(published.version.contentToken)).toBe(true);
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    runtime = openRuntime();
    const replay = await runtime.runPromise(commit(command));
    expect(replay.artifact.id).toBe(published.artifact.id);
    expect(replay.version).toEqual(published.version);
    expect(replay.replayed).toBe(true);
  });

  test("foundation: the current pointer stays on the previous bytes until the next content address is ready", async () => {
    const first = await runtime.runPromise(commit(await prepare("<h1>One</h1>", "ingress-one", newArtifact)));
    const command = await prepare("<h1>Two</h1>", "ingress-two", {
      kind: "new_version", artifactId: first.artifact.id, expectedCurrentVersionId: first.version.id,
    });
    pause = await Effect.runPromise(Deferred.make<void>());
    const pending = runtime.runPromise(commit(command));
    await Effect.runPromise(Deferred.await(entered));
    const before = await repository.findCurrentVersion(first.artifact.projectId, first.artifact.id);
    expect(before?.version.id).toBe(first.version.id);
    await Effect.runPromise(Deferred.succeed(pause, undefined));
    const second = await pending;
    const after = await repository.findCurrentVersion(first.artifact.projectId, first.artifact.id);
    expect(after?.version.id).toBe(second.version.id);
    expect(ready.has(second.version.contentToken)).toBe(true);
    expect(second.version.number).toBe(2);
  });

  test("foundation: a Review lease is not issued while its address cannot be made ready", async () => {
    const published = await runtime.runPromise(commit(await prepare("<h1>Review</h1>", "ingress-review", newArtifact)));
    const command = {artifactId: published.artifact.id, principal, projectId: null, versionId: published.version.id};
    unavailable = true;
    const failed = await runtime.runPromise(Effect.result(ContentAccessService.use(service => service.issuePreviewLease(command))));
    expect(failed).toMatchObject({failure: {_tag: "ContentIngressUnavailable"}});
    unavailable = false;
    const lease = await runtime.runPromise(ContentAccessService.use(service => service.issuePreviewLease(command)));
    expect(ready.has(Redacted.value(lease.token))).toBe(true);
    const content = await runtime.runPromise(ContentAccessService.use(service => service.authorizePreviewContent({
      fallback: "entry", path: "", token: lease.token,
    })));
    expect(content?.versionId).toBe(published.version.id);
  });
});
