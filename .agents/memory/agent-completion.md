---
name: Evidence-based agent completion
description: Repair autonomy must be verified by Forge, not by the model's final prose.
---

Improve Forge's ability to diagnose and repair imported apps rather than manually fixing each imported app and calling the underlying problem solved.

**Why:** The user identified autonomous repair as the actual goal after an imported IPAM app was repeatedly rewritten and reported working while its managed runtime was still starting.

**How to apply:** Use failing imports as regression cases. Keep evidence-based completion checks outside the model's discretion, bound repair attempts, preserve files and database migration history, and distinguish platform-launcher faults from project faults.

Hold post-mutation completion prose until verification; keep tool progress streaming and ordinary discussion unaffected.

**Why:** Checking after streaming an unsupported success claim is too late. HTTP readiness is useful evidence, but does not prove browser rendering or application features.

**How to apply:** State verification scope explicitly; never label a signed HTTP smoke check a full end-to-end feature test. Scripted-model regressions test orchestration, not the deployed model's real-world repair ability.

Investigate tool contracts before attributing repetitive diagnosis entirely to model reasoning.

**Why:** An IPAM transcript showed the agent requesting later file ranges while the tool silently ignored pagination and repeatedly returned the beginning. The completion guard prevented a false success but did not prevent the wasted repair budget.

**How to apply:** Test the exact arguments captured in failed transcripts, surface unsupported inputs explicitly, and make truncated output explain how to retrieve the missing portion. Separate truthful completion reporting from actual repair competence.