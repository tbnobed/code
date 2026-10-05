---
name: Claude Code on the DGX
description: User-requested server-side Claude Code and subscription authentication.
---

The user requested Claude Code running on their server instead of attaching through an API, and asked to be prompted for the login token when needed.

**Why:** Explicit user direction. This permits Claude Code's hosted Claude connection despite the older Ollama-only direction; it does not mean Claude inference runs locally on the DGX GPU.

**How to apply:** Use Claude Code's official native Linux ARM64 installation and documented subscription OAuth authentication, not the project's Anthropic API proxy credentials. Collect any requested token through the secure secrets flow, never chat. Distinguish installing/authenticating the CLI from integrating it as Forge's execution backend.

The user clarified that **local AI remains the coding agent**; Claude Code is an on-demand advisor, called only when they click the shield button, using as few tokens as possible.

“Claude should not be doing any work until I call on it.”

**Why:** The user explicitly objected to seeing Claude continue working when they had not intended to invoke it.

**How to apply:** Do not launch Claude-driven tests, repair runs, or continuations on the user's behalf without an explicit request. An idle connector may stay available for user-initiated requests, but it must not autonomously start coding work.

**Why:** The user explicitly corrected the earlier always-on Claude coding-backend interpretation.

**How to apply:** Keep subscription credentials on the host. Local AI prepares a small focused brief only after the explicit shield click. Never send the full conversation/workspace, delegate automatically on errors, use Claude for ordinary coding turns, or resume work after advice without a new user request. Minimize CLI instructions and output, with hard brief/output limits and no automatic retries.

Initiate the remote browser-login flow and give the user its actual authorization URL, rather than only telling them to run a login command themselves.

**Why:** The user explicitly asked for the missing login URL after being given terminal instructions. A remote login needs stdin kept open so the securely supplied browser code can reach the same waiting process.

**How to apply:** Use a private input channel for the pending CLI login, never print the returned code, and verify subscription authentication with a tools-disabled request in an isolated directory. Do not save temporary authorization URLs, codes, or credentials in project memory.