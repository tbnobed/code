---
name: Claude Code on the DGX
description: User-requested server-side Claude Code and subscription authentication.
---

The user requested Claude Code running on their server instead of attaching through an API, and asked to be prompted for the login token when needed.

**Why:** Explicit user direction. This permits Claude Code's hosted Claude connection despite the older Ollama-only direction; it does not mean Claude inference runs locally on the DGX GPU.

**How to apply:** Use Claude Code's official native Linux ARM64 installation and documented subscription OAuth authentication, not the project's Anthropic API proxy credentials. Collect any requested token through the secure secrets flow, never chat. Distinguish installing/authenticating the CLI from integrating it as Forge's execution backend.

The user explicitly approved connecting Forge to Claude Code as its coding backend.

**Why:** They want to use the authenticated server CLI through Forge, not merely from a terminal.

**How to apply:** Keep subscription credentials on the host, outside generated projects. Use the CLI for coding decisions while preserving Forge's tool execution, cancellation, checkpoints and independent completion gate; do not silently fall back to Ollama on Claude errors.

Initiate the remote browser-login flow and give the user its actual authorization URL, rather than only telling them to run a login command themselves.

**Why:** The user explicitly asked for the missing login URL after being given terminal instructions. A remote login needs stdin kept open so the securely supplied browser code can reach the same waiting process.

**How to apply:** Use a private input channel for the pending CLI login, never print the returned code, and verify subscription authentication with a tools-disabled request in an isolated directory. Do not save temporary authorization URLs, codes, or credentials in project memory.