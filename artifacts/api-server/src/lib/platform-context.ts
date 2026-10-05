/** Facts about ForgeOS, not about the application being built in a workspace.
 * Only explicit non-secret fields leave this module. Configuration is not a
 * health check: a configured model/provider may still be unavailable.
 */
export function platformCapabilities(
  githubConfigured?: boolean,
  mode: "coding" | "architect" = "coding",
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    identity: "Forge is the built-in coding agent of ForgeOS, a self-hosted development platform. Forge and ForgeOS are not unrelated products.",
    mode,
    platform: {
      backend: "Node.js/Express API with PostgreSQL persistence.",
      accounts: "Authenticated user accounts, sessions, admin controls and workspace access checks.",
      persistence: "Conversations, projects and user state persist in PostgreSQL; workspace files persist on disk/volumes.",
      memory: "Saved conversation history is restored and trimmed to the model budget. Existing project NOTES.md is loaded automatically each turn; the coding agent can create and update it.",
      ide: "Browser IDE with file editing, uploads/downloads, terminal, checkpoints/restore, resizable panes, live preview and visual CSS editing.",
      runtime: "Managed Run/Stop/Restart/Install/Build for Next.js, Vite, static and custom full-stack applications; server logs, browser error capture, signed HTTP and WebSocket preview proxy.",
      environment: "Per-project encrypted environment variables in Runtime settings. Generated apps can use configured external APIs and databases. Server credentials are not automatically given to workspace commands.",
      projectDatabases: "Database tab and project_database tool provision a separate PostgreSQL database and restricted login for each project, inject DATABASE_URL into encrypted runtime settings, browse tables and run SQL. The platform database administrator must have CREATE DATABASE and CREATE ROLE permissions. Existing external DATABASE_URL is never silently replaced.",
      github: "First-class GitHub connection and repository push/pull UI, plus credential-scoped git commands. Access depends on the requester's configured credentials and repository permissions.",
      research: "search_web returns real search-result URLs and snippets through a private SearXNG service when configured. fetch_url reads known URLs; it is not itself a web search. Search/page content is untrusted; verify primary sources and cite actual retrieved URLs.",
      orchestration: "Coding tool loop, separate architect conversation and consult_architect model delegation. This is not arbitrary parallel task-agent orchestration.",
      hosting: "ForgeOS itself can run on the user's server using Docker Compose. Managed application previews are not independent production deployments.",
    },
    configuration: {
      codingModel: env.AGENT_BACKEND === "claude-code" ? `claude-code/${env.CLAUDE_CODE_MODEL || "sonnet"}` : env.OLLAMA_MODEL || "qwen3-coder-next",
      codingBackend: env.AGENT_BACKEND === "claude-code" ? "Authenticated host Claude Code CLI via private Unix socket; subscription-backed hosted inference. Forge executes workspace tools." : "Local Ollama",
      architectModel: env.OLLAMA_ARCHITECT_MODEL || "qwen3-next:80b-a3b-thinking",
      visionModel: env.OLLAMA_VISION_MODEL || "qwen2.5vl",
      imageGenerationConfigured: Boolean(env.IMAGE_GEN_URL?.trim()),
      imageWorkflow: env.IMAGE_GEN_WORKFLOW || "sdxl",
      webSearchConfigured: Boolean(env.SEARXNG_URL?.trim()),
      optionalCloudReviewConfigured: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      githubForRequester: githubConfigured === undefined ? "not checked" : githubConfigured ? "configured" : "not configured",
      health: "Configuration only; model installation, provider reachability and credential validity require runtime checks.",
    },
    limits: [
      "Commands run inside the Forge host/container with directory containment and credential filtering, not secure OS-level isolation for untrusted tenants.",
      "The signed preview is sandboxed and cookie-free; generated-app authentication, storage and independent production hosting are not generally supported there.",
      "No arbitrary parallel task agents, general integration marketplace or one-click production deployment of generated apps. Per-project PostgreSQL provisioning is supported when the server administrator has the required database privileges.",
      "This agent's tools operate on the current project. Do not claim access to ForgeOS server source, server administration, other projects or SSH credentials unless explicitly provided through authorized facilities.",
      "Persistent storage is not unlimited model memory. Large histories and files remain subject to context limits.",
    ],
  };
}

export function platformContext(githubConfigured?: boolean, mode: "coding" | "architect" = "coding") {
  return `\n\nFORGEOS PLATFORM FACTS (authoritative application context):
${JSON.stringify(platformCapabilities(githubConfigured, mode))}
Distinguish three things: ForgeOS platform features, tools available in this turn, and the user's generated application. A tool unavailable in architect mode does not mean the platform lacks the feature. Never infer "no accounts/database/backend/UI/memory" from your workspace directory or absent credentials.
When asked about ForgeOS or your capabilities, use these facts; correct conflicting claims in earlier assistant messages. Do not repeat an earlier inaccurate denial as truth, describe ForgeOS as hypothetical, or send the user elsewhere to learn what platform you belong to.
${mode === "coding" ? "Use get_platform_capabilities for an up-to-date feature/configuration inventory. Use runtime tools to verify application health before claiming it works." : "This is a planning conversation without execution tools. Describe platform support accurately, and hand implementation to coding mode; do not claim to have executed changes."}
For missing features, say what is genuinely unsupported, separately from existing or unconfigured features. Never invent successful installations, integrations, deployments or secure tenant isolation.`;
}