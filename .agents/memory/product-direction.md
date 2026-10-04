---
name: ForgeOS product direction
description: User's requested scope for the development environment.
---

The user wants ForgeOS to "work exactly like replit," including running full web apps and being able to design visually, rather than only chat-based code generation and basic previews.

**Why:** The user explicitly stated this product goal after a generated application built successfully but its preview returned an internal server error.

**How to apply:** Treat reliable application execution and visual design as core product goals. Scope delivery into working milestones; do not claim complete Replit feature parity from a preview or UI-only change.

Per-project database capabilities are mandatory: "I need per project database capabilities, no execption."

**Why:** The user explicitly rejected leaving per-project databases as an unsupported platform limitation.

**How to apply:** Provide real provisioning and usable database controls, not just an environment-variable field for an externally provisioned database.

Keep the Forge agent's own tool access distinct from ForgeOS platform features and from the generated application.

**Why:** The user reported Forge disowning ForgeOS and falsely denying existing accounts, database persistence, memory, IDE and integrations. Restricted workspace access is not evidence those platform features are absent.

**How to apply:** Ground agent self-descriptions in implemented platform features while stating genuine limitations. Do not solve inaccurate denials by promising unimplemented hosting, tenant isolation or parallel orchestration.

The user asked to keep building Replit-like features and automatically deploy them to their own server.

**Why:** The user explicitly requested continued implementation and server deployment instead of stopping at each feature proposal.

**How to apply:** Include deployment and health verification in authorized batches. This standing preference does not authorize unrelated server changes or remove required confirmation for future high-impact actions.