# 0029: Qualify Pages content ingress with bounded retention

**Status:** Accepted direction; provider mechanics exercised; application qualification pending
**Date:** October 29, 2026

A Cloudflare installation with one purchased domain needs separate browser
origins for its application and untrusted artifact content. Qualify a Pages
Functions gateway as the content ingress, while retaining the complete Artifact
Server application on Workers. Keep storage growth bounded through quotas and
reversible deactivation before introducing permanent deletion.

This records the next deployment direction. It does not introduce a supported
Pages deployment or supersede the retention guarantees in
[0003](0003-artifact-lifecycle-and-audit.md) and
[ART-006, ART-007, and PUB-009](../conformance.yml).

## Content ingress

The application, API, and MCP stay on the application domain, for example
`artifacts.danran.one`. D1 stores records and R2 stores immutable version bytes.
One Pages project supplies a separate origin for each published version using
registered preview aliases under `<project>.pages.dev`. Its Functions gateway
calls the central Worker through a Service Binding; Pages holds no artifact
files. Product services remain independent of Pages, D1, R2, and HTTP.

A Pages alias is mutable at the provider. The application must persist its
association with one version and never reassign it to another. Advertise the
registered version alias, not the deployment hash URL. Check every ingress,
including hash and project URLs, so another Pages hostname cannot bypass
artifact authorization. Reject unknown hostnames without using them as raw
storage locations.

Publication succeeds and advances the current version only after its ingress
is ready. Retries and interrupted deployment must preserve version IDs and
bytes. Provisioning credentials belong to the deployment control path, never
to artifact code or browser responses. Revocation and deactivation take effect
at the central authorization boundary; deleting a Pages deployment is not an
authorization mechanism. Private responses remain non-cacheable.

Stable artifact links resolve the current version. Exact-version links retain
their version identity and show unavailability after deactivation; they never
silently resolve another version. Reusing an ingress for Review would avoid a
new deployment for each preview lease, but is not assumed to work. The browser probe below
confirms that a version's strict session cookie cannot authorize cross-site
Review requests. Preserve a distinct lease capability, expiry, sandbox, and
root-relative file resolution when adapting the ingress.

## Storage and retention

Count committed bytes, pinned versions, and staged uploads toward configured
capacity limits. Reserve capacity before accepting upload bytes and account
for concurrent uploads. Bound publication size and version growth as well as
bytes. On exhaustion, reject additional storage growth while preserving access
to existing readable content. Storage limits do not cap request charges; rate
limits and usage alerts must cover read traffic separately.

Automatically clean expired, uncommitted staging through the existing bounded
cleanup behavior. Add explicit historical-version deactivation before any
automatic committed-version retention policy. Deactivation stops serving the
version while retaining immutable bytes and records. Current versions must
remain available; selecting another current version is a separate operation.
Pinning must not bypass capacity limits.

Do not enable permanent committed-version or orphan-blob collection until a
separate policy and tests prove reference accounting, concurrent publication
safety, and recovery. Removing a Pages deployment does not reclaim R2 bytes.
An archive or artifact tombstone alone also does not reclaim those bytes.

Backup retention must be specified alongside deletion: restore metadata and
bytes from a consistent recovery point, preserve access restrictions and
tombstones, and prevent a restore from reopening deactivated content. A future
permanent-deletion policy must explain when retained backups also stop holding
the deleted bytes. Existing coordinated-recovery tooling remains the starting
point.

No numeric capacity defaults or version-count/age retention schedule is chosen
here. Previously discussed counts and day ranges are candidates only.

## Qualification before implementation

Use an isolated Pages project and test Worker with disposable fixtures. Do not
change production DNS, invoke the full production deployment, or copy private
artifact data. Track and clean up only resources created by this probe.

| Question | Required observation |
| --- | --- |
| Publication delay | Measure submission to successful content delivery across repeated Direct Uploads; record latency and provider limits without equating them to Git-build quotas. |
| Alias recovery | Delete a disposable deployment, redeploy identical bytes under the same alias, and verify the old alias URL and content digest. Record hash-URL behavior separately. |
| Access boundary | Check registered aliases, project URLs, and deployment hashes for public/private transitions, revocation, cross-version access, and cache behavior through the Service Binding. |
| Browser behavior | In a real browser, exercise cross-site private-content bootstrap and Review from the application origin, including lease expiry, root-relative assets, scripts, fetches, and sandbox isolation. |
| Interrupted publication | Fail ingress provisioning and retry; prove that failure cannot expose a new current version or change committed IDs or bytes. |
| Reversible deactivation | Deny content centrally before deleting a disposable ingress, retain its records and bytes, and qualify recovery of its registered alias before promising old-link restoration. |

A fixture gateway can qualify provider mechanics. It cannot prove the complete
Artifact Server private-content or Review flows; those need the real application
and browser tests after adaptation. Do not weaken cookie or sandbox protections
to make the provider experiment pass. Attach passing product evidence to the
conformance ledger when implementation exists, not on acceptance of this ADR.

## Current qualification status

The October 29 preflight initially received HTTP 403, code `10000`,
`Authentication error` from the Pages projects endpoint. After the owner added
account-scoped Pages edit permission, the endpoint returned HTTP 200. No
additional account scope or global API key was needed.

A disposable project, `as-pages-probe-mvt7edo6-1f7ba7`, and its `-origin` Worker
exercised Direct Upload and a Pages-to-Worker Service Binding. The probe used
static fixtures, no D1 or R2, and a temporary application at a `workers.dev`
origin. Chrome drove the cross-site browser checks.

| Observation | Result and limit |
| --- | --- |
| Gateway | Registered version aliases reached the bound Worker. Unregistered project and deployment-hash hostnames returned 404 at the origin boundary. |
| Warm publication | Three consecutive same-alias uploads used a unique response marker to distinguish the new deployment from the previous one. Submission-to-marker delivery took 2,843, 2,409, and 2,490 ms; API submission alone took 1,095, 1,117, and 1,156 ms. These are fixture observations, not a production latency guarantee. |
| Cold readiness | Early preview and hash requests failed TLS negotiation despite API deployment success. Later requests succeeded without bypassing certificate validation. Cold-start readiness must include actual HTTPS delivery; this run did not establish a cold-start latency bound. |
| Alias recovery | Deleting the public fixture deployment with `force=true` made its alias and old hash URL return 404. Redeploying restored the same alias and identical response SHA-256, `98baf794fe82bb59f954df567a426a7386bbfdbf39127c1d0ac4ace7084c631a`. The old hash URL stayed unavailable. |
| Private session | A top-level bootstrap set a Secure, HttpOnly, SameSite=Strict host cookie; the private page, script, and style loaded. Missing or invalid cookies returned 401. An iframe at the separate application site returned 401 even after successful top-level login. |
| Review-shaped fixture | An opaque-origin `sandbox="allow-scripts"` frame could not use the private session. A distinct lease alias with preview CORS headers loaded its script and root-relative JSON fetch, while reading the parent document failed. This exercised provider/browser mechanics, not the real Review application. |
| Central denial | With Pages deployments still present, changing the origin fixture's policy produced 410 for the deactivated public version and 403 for the revoked private session and simulated expired lease. Responses were `no-store`. This did not exercise a real expiry clock or product persistence. |
| Cleanup | The probe project and Worker were deleted. Follow-up account lists contained the original three Pages projects and three Workers, with neither probe resource present. Existing resources and production DNS were unchanged. |

The experiment supports the gateway and alias-recovery direction. It does not
qualify quotas, real publication failure recovery, cross-version authorization,
D1/R2 recovery, or the complete Artifact Server private-content and Review
flows. Preserving the existing lease-host model would require an alias for each
lease; deployment counts, latency, and any alternative lease ingress need an
explicit design before claiming that version ingress can be reused.

The local `pnpm verify:iteration` gate was attempted but stopped at
`check:release-version`: `ERR_MODULE_NOT_FOUND` for `zod`. Dependencies are
incomplete; no full iteration pass or supported Pages installation is claimed.

## Provider references

- [Pages API authentication](https://developers.cloudflare.com/pages/configuration/api/)
- [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Pages Service Bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings)
- [Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/)

## Implementation plan

Scope chosen for the first increment: make publication, content access, and
hosted login work end to end. Review previews keep the existing per-lease host
model, so a lease costs one content-origin alias; reusing version ingress for
leases stays a later design.

1. Contract: `CloudflareContentOrigin` lets a Cloudflare deployment name a
   provider-managed content origin. `{"kind": "cloudflare-pages",
   "projectName": "..."}` requires `contentDomain` to be exactly
   `<projectName>.pages.dev`, supplies only the application DNS zone, and
   rejects a content DNS zone. An absent or `wildcard-dns` origin keeps the
   existing wildcard DNS record and Worker route. This increment is the
   contract and validation only; no provider behaviour changes yet.
2. Stack: create the Pages project and its gateway deployment, bind the
   gateway to the application Worker through a service binding, and stop
   creating the wildcard content DNS record and Worker route for a Pages
   origin. The Worker receives the account ID, project name, and a Pages
   deployment credential.
3. Runtime: a content-origin port with a Cloudflare Pages adapter that
   provisions one alias deployment per version host, is idempotent under
   retry, and records the durable alias-to-version association before
   publication commits. Publish order becomes: write immutable bytes, prove
   the alias serves over HTTPS, then commit metadata and the current pointer.
4. Recovery: an interrupted publication leaves the version unreferenced but
   recoverable; retrying reuses the same version ID and bytes. Deactivation
   and revocation stay central and never depend on deleting a Pages
   deployment.
5. Verification: contract and adapter tests through real HTTP boundaries,
   then a staging deployment and a browser login check. Ledger rows stay
   unverified until those pass.
