/** The Pages gateway can call only its configured application binding. */
export interface PagesGatewayEnvironment {
  readonly ARTIFACT_SERVER: {
    fetch(request: Request): Promise<Response>;
  };
  readonly ARTIFACT_SERVER_CONTENT_DOMAIN: string;
  readonly ARTIFACT_SERVER_ORIGIN: string;
  readonly ARTIFACT_SERVER_GATEWAY_REVISION: string;
}

/**
 * The import-free advanced-mode module uploaded to Cloudflare Pages.
 * Keep this source constant: deploy-time and bundled Worker code must compute
 * the same revision regardless of how their own TypeScript was transformed.
 */
export function pagesGatewayModule(): string {
  return `export default {
  async fetch(request, environment) {
    const unavailable = (status) => new Response(null, {
      status,
      headers: {"Cache-Control": "no-store"},
    });
    const url = new URL(request.url);
    const suffix = "." + environment.ARTIFACT_SERVER_CONTENT_DOMAIN;
    if (!url.hostname.endsWith(suffix) || url.protocol !== "https:") {
      return unavailable(404);
    }
    const token = url.hostname.slice(0, -suffix.length);
    if (!/^(?:[a-f0-9]{36}|review-[a-f0-9]{56})$/.test(token)) {
      return unavailable(404);
    }
    try {
      if (url.pathname === "/__artifact_server_gateway_ready") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return unavailable(405);
        }
        const healthUrl = new URL("/health", environment.ARTIFACT_SERVER_ORIGIN);
        const health = await environment.ARTIFACT_SERVER.fetch(new Request(healthUrl, {
          signal: AbortSignal.timeout(5000),
        }));
        await health.body?.cancel();
        return new Response(null, {
          status: health.status === 200 ? 204 : 503,
          headers: {
            "Cache-Control": "no-store",
            "X-Artifact-Gateway-Revision": environment.ARTIFACT_SERVER_GATEWAY_REVISION,
          },
        });
      }
      // Preserve the URL, cookie, method, range, and streaming body. The central
      // application owns host lookup, authorization, expiry, and response policy.
      return await environment.ARTIFACT_SERVER.fetch(request);
    } catch {
      return unavailable(503);
    }
  }
};\n`;
}
