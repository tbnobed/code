# Managed application runtime

Update the DGX installation from its ForgeOS repository directory:

```sh
git pull && docker compose up -d --build
```

This rebuild restarts Forge and interrupts active operations, but preserves workspace/database volumes. No model changes are required.

## Running a project

Open the session's **Preview** pane. Its runtime controls provide:

- **Run**: install dependencies when needed and start the application.
- **Stop**: terminate managed processes. Old preview links cannot restart them.
- **Restart**: stop and start with current settings and packages.
- **Install**: reinstall dependencies without deleting the lockfile or forcing major upgrades.
- **Build**: run the root package's build script with `NODE_ENV=production`.

Operations run in the background. Status, bounded server output and errors are available in the panel. Failed application HTTP responses display redacted runtime diagnostics. The Browser Errors tab receives uncaught JavaScript errors and rejected promises from the embedded page.

Next.js and Vite are detected from the root package.json. Static projects use root index.html. Dependency manifest/lockfile changes detected on preview requests trigger a restart. Explicit Install remains available for incomplete/corrupt node_modules.

The agent can use configure_runtime, manage_runtime and get_runtime_status to configure, launch, build and diagnose apps without starting duplicate shell servers.

## Custom full-stack applications

Set a **frontend command** when automatic detection does not fit, e.g. `npm run dev`.
The command must listen on the supplied `PORT`; `HOST` is set to 127.0.0.1.

An optional **backend command** runs in its own workspace-relative directory on another assigned port. Requests to `/api` and `/api/...` inside the signed preview are routed to that backend **without removing `/api`**. Otherwise they go to the frontend (including Next.js route handlers). A static frontend can also use a backend.

Use base-path-aware assets and requests: Vite's import.meta.env.BASE_URL, Next's configured basePath, or FORGE_PREVIEW_BASE / BASE_PATH for custom servers. The preview bridge also adjusts string-based root-relative fetch/XHR and same-host WebSocket requests. This is not a universal rewrite of all generated application URLs; absolute URLs, Request objects, custom routers and service workers may need application-specific configuration.

Saving settings stops the runtime. Start it again to apply changes.

## Environment and databases

Add project variables in Runtime settings, e.g. DATABASE_URL for a database you have provisioned separately. Values are encrypted using Forge's SESSION_SECRET, stored outside the source tree, omitted from ZIPs/checkpoints, and never returned to the browser. Blank updates remove existing keys.

Do not rotate SESSION_SECRET without backing up and planning re-entry of project credentials. Framework-prefixed variables intended for client bundles (e.g. VITE_ / NEXT_PUBLIC_) are public by definition; never place secrets in them. Do not put credentials directly into command strings.

The Database tab provisions a separate PostgreSQL database and restricted login for each project, injects DATABASE_URL into its encrypted runtime environment, lists tables and runs single SQL statements. The Forge database administrator must have CREATE DATABASE and CREATE ROLE privileges; the self-hosted Compose PostgreSQL administrator has these by default. Existing external DATABASE_URL values are not overwritten. Restart a running application after provisioning.

Query results are limited to 200 rows/1 MiB, with a five-second statement timeout. Database deletion requires explicit confirmation and stops the project runtime. Projects with a managed database cannot be deleted until their database is explicitly removed. Database contents are not part of filesystem checkpoints or project ZIPs; use PostgreSQL backups before destructive operations. This does not migrate or replace ForgeOS's application database.

## Limits and security

- Three active projects, 15-minute idle cleanup, 120-second custom-server startup deadline, 10-minute install/build deadline.
- Settings persist; managed processes do not automatically resume after restarting Forge.
- WebSockets are proxied through signed preview paths. Next/Vite live-update servers and custom application sockets use that path.
- Preview iframes retain their opaque-origin sandbox. Features requiring same-origin cookies, storage or unrestricted browser navigation may need an independently hosted application origin. Do not remove the sandbox to make them work.
- Stripped server credentials and separate process groups are **not** OS-level tenant isolation. Custom/generated commands still execute inside the Forge container. Run only trusted users/projects; this is not a safe public untrusted-code hosting service.
- Authentication/session cookies for generated applications are not supported by the cookie-free preview proxy. Keep Forge's own cookies isolated.

## Verification

`pnpm --filter @workspace/api-server run test:runtime` exercises environment selection, log redaction, custom frontend/backend lifecycle, build mode, failure handling and containment.

Real Next and Vite fixtures were also checked through the signed HTTP proxy, as were custom backend POST requests and WebSocket upgrades.