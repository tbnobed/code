---
name: Framework preview constraints
description: Non-obvious runtime constraints for Next.js/Vite previews inside Forge.
---

Workspace commands must use a development environment independently of the production Forge server.

**Why:** Production NODE_ENV and npm omit/production settings caused repeated successful-looking installs that left Tailwind build dependencies absent.

**How to apply:** Preserve the server's production settings, but clear inherited npm omission settings and explicitly include development dependencies in workspace child environments.

Next.js custom development servers may ignore the conf argument to next() because the routing server independently reloads configuration. Next's config module also exposes default through a getter, so assigning to default does not reliably replace the loader.

**Why:** Real Next preview tests initially returned 404s and unprefixed assets despite a supplied basePath. Child-local module-export replacement preserved project config functions while applying the signed prefix to subsequent loads.

**How to apply:** When updating Next compatibility, test the actual signed route and its JS assets, not just server readiness. Recheck this internal API on Next upgrades. Never evaluate generated project configuration inside the Forge server process.

Preview tokens are part of framework base paths; token changes can require server/config/cache changes, not just navigation.

**Why:** Frequently replacing tokens can restart compilers, and Next's trailing-slash redirects can accidentally duplicate a signed prefix or create a redirect loop.

**How to apply:** Keep tokens stable across ordinary reloads, renew before expiry, isolate compiler output across distinct signed bases, and test both slash and no-slash root routes. Preserve opaque-origin sandboxing and keep Forge cookies/credentials out of framework requests.