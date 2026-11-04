import {Effect} from "effect";

import type {ContentIngressUnavailable} from "../core/errors.js";

/** Make one immutable version or read-only preview hostname available before use. */
export interface ContentIngress {
  readonly ensureReady: (contentToken: string) => Effect.Effect<void, ContentIngressUnavailable>;
}

/** Custom DNS installations already route every content hostname to the application. */
export const routedContentIngress: ContentIngress = {
  ensureReady: () => Effect.void,
};
