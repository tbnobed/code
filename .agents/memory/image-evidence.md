---
name: Generated-image evidence
description: Keep generation history and vision analysis tied to exact image versions.
---

Each generated-image card must represent its own saved output, not the current file at a reusable filename.

**Why:** The user supplied screenshots of repeated logo revisions showing the same image while analysis described different cars. All cards referenced a mutable logo filename, so the displayed image was not reliable evidence of what each generation produced or what vision analyzed.

**How to apply:** Preserve versioned bytes and tie generation/analysis evidence to a content fingerprint. Do not reconstruct old image history from a current overwritten file. Treat vision-model descriptions as fallible interpretations, not proof that a requested style or quality was achieved.