// pi's login events → the `oauth_progress` payloads this server broadcasts.
//
// Extracted from the login route so the translation can be tested without
// starting an OAuth flow against a real provider — which is the one part of the
// provider surface that cannot be exercised locally.
//
// pi 0.82 replaced a bag of named callbacks (onDeviceCode / onAuth / onProgress)
// with a single `notify(event)`. The wire format did NOT change: clients still
// read the same four `type`s, so this maps four in to three out.

import type { AuthEvent } from "@earendil-works/pi-ai"

export type OAuthProgress =
  | { provider: string; type: "device_code"; userCode: string; verificationUri: string }
  | { provider: string; type: "auth_url"; url: string; instructions?: string }
  | { provider: string; type: "progress"; message: string }

export function oauthProgressPayload(provider: string, event: AuthEvent): OAuthProgress {
  switch (event.type) {
    case "device_code":
      return {
        provider,
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
      }
    case "auth_url":
      return { provider, type: "auth_url", url: event.url, instructions: event.instructions }
    // "info" is new in 0.82 — a message with optional links. Clients know
    // "progress", and an info line IS progress to whoever is reading the panel,
    // so it lands there rather than being dropped on the floor.
    case "info":
    case "progress":
      return { provider, type: "progress", message: event.message }
  }
}
