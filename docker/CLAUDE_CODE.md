# Claude Code coding backend

Forge can use an authenticated **host Claude Code CLI** instead of Ollama for coding turns. This uses Claude subscription authentication, not an Anthropic API key. Inference is hosted by Anthropic; the DGX still executes Forge tools and local image/vision services.

The CLI returns structured decisions. Forge retains its existing tool execution, history, checkpoints, cancellation and signed-preview completion gate. Architect mode remains on its separately configured Ollama model. There is no silent fallback if Claude fails.

## Host setup

1. Install the official native Claude Code CLI under `~/.local/bin/claude`, then authenticate with `claude auth login --claudeai`.
2. Place this repository at `~/code`, or adjust the `ExecStart` path in `forge-claude-code.service`.
3. Install the service:

   ```sh
   mkdir -p ~/.config/systemd/user
   cp docker/forge-claude-code.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now forge-claude-code
   ```

4. The user service must run after logout/reboot. An administrator can enable this with `loginctl enable-linger <host-user>`.
5. Check the container user with `docker compose exec forge id -u`. If it differs from `1001`, update `FORGE_UID` in the service and reload/restart it.
6. Activate the Compose override:

   ```sh
   docker compose -f docker-compose.yml -f docker/claude-code.compose.yml up -d --build forge
   ```

   For subsequent plain `docker compose` commands, set the non-secret `COMPOSE_FILE=docker-compose.yml:docker/claude-code.compose.yml` in the host repository's `.env`. Do not replace existing `.env` contents.

Existing Ollama model preferences are preserved in storage; the API presents the effective Claude model while this backend is enabled. The model selector offers `claude-code/sonnet`, `claude-code/opus` and `claude-code/haiku`.

## Security and operations

- Only the Unix socket directory is mounted into Forge, read-only. Claude credentials remain with the host user.
- The bridge checks the connecting Unix UID and accepts only the host owner or configured Forge UID.
- CLI requests run in temporary directories, with built-in tools disabled, no MCP servers, no project/user settings, no persisted CLI session, and a minimal environment. File operations run through Forge's existing tools.
- Requests have concurrency, input/output and time limits. Disconnecting kills the CLI process group.
- The socket is recreated safely on service restart because Compose mounts its directory, not an individual socket inode.
- Check service health using `systemctl --user status forge-claude-code`. Check login using `~/.local/bin/claude auth status`.
- This is not a secure sandbox for untrusted tenants: Forge's existing command execution still has container-level access.

To return to Ollama, remove this override from `COMPOSE_FILE` and recreate Forge using the base Compose file. This does not delete workspaces, history or Claude authentication.