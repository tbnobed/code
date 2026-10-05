# On-demand Claude Code help

**Normal coding and architect turns use local Ollama.** Claude Code is contacted only by the explicit shield-button help endpoint. It is not an agent tool and is never automatically invoked on errors, page loads, retries of local coding, or after a help response.

On a shield click:

1. The local model prepares a brief from the latest request, three recent tool results, and a bounded code-diff sample.
2. Only that brief (maximum **3,200 UTF-8 bytes**) goes to the host Claude Code CLI, not the full conversation, tool schemas, or entire workspace.
3. The CLI runs one advisory process, without tools, MCP, session persistence, or user/project settings. Output is configured to **1,024 tokens**, low effort, and requested to stay under 250 words.
4. Advice is saved to the conversation. No edits or coding continuation start automatically. The user can tell the local agent to apply it.

The application does not retry Claude requests automatically. A failed/empty local brief prevents any Claude request. Concurrent duplicate help requests for the same project are rejected. Stop aborts brief preparation or the Claude process.

The 3,200-byte limit bounds the **project brief**, not total provider token usage: the CLI adds its own instructions and protocol overhead. Byte limits and token limits are not equivalent.

## Host installation

Install and authenticate the official native CLI under `~/.local/bin/claude` using `claude auth login --claudeai`. Credentials remain with the host user; no API key is used.

With the repository at `~/code`:

```sh
mkdir -p ~/.config/systemd/user
cp docker/forge-claude-code.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now forge-claude-code
docker compose -f docker-compose.yml -f docker/claude-code.compose.yml up -d --build forge
```

For persistent Compose configuration, add `COMPOSE_FILE=docker-compose.yml:docker/claude-code.compose.yml` to the existing host `.env` without replacing its contents. The override enables **help only**, not a coding backend.

Adjust service `ExecStart` if the checkout is elsewhere, and `FORGE_UID` if `docker compose exec forge id -u` differs from `1001`. Enable user lingering for reboot/logout persistence if needed.

The bridge listens only on a Unix socket and checks peer UID. Only its socket directory is mounted into Forge; credentials stay outside the container. It enforces input size, concurrency, cancellation and timeout limits, and rejects the obsolete coding `/completion` endpoint.

The idle service performs **no model requests**. Health checks must not invoke Claude. Tests use fake responses; do not run live Claude validation without the user's explicit request.