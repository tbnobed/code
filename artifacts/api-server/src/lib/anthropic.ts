import Anthropic from "@anthropic-ai/sdk";

// "Send for review" is an OPT-IN cloud feature in an otherwise local-only
// app — the session diff leaves the machine, so it only activates when
// credentials are explicitly present.
//
// Precedence: explicit ANTHROPIC_* (self-hosted DGX path, user's own key)
// over AI_INTEGRATIONS_ANTHROPIC_* (Replit-managed proxy, dev workspace).
// Absent both, reviewAvailable() is false: the UI hides the button and the
// route answers 503.
// `||` (not `??`): compose passes empty strings for unset vars — treat those
// as absent so they fall through instead of shadowing.
const API_KEY =
  process.env.ANTHROPIC_API_KEY || process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
const BASE_URL =
  process.env.ANTHROPIC_BASE_URL || process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;

export const REVIEW_MODEL = process.env.ANTHROPIC_REVIEW_MODEL || "claude-sonnet-4-6";

export function reviewAvailable(): boolean {
  return Boolean(API_KEY);
}

let client: Anthropic | null = null;

/** Lazy so an unconfigured server still boots — review is optional. */
export function getAnthropic(): Anthropic {
  if (!API_KEY) {
    throw new Error("Anthropic is not configured — set ANTHROPIC_API_KEY");
  }
  if (!client) {
    client = new Anthropic({ apiKey: API_KEY, ...(BASE_URL ? { baseURL: BASE_URL } : {}) });
  }
  return client;
}
