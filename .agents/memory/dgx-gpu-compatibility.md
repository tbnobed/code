---
name: DGX GPU compatibility
description: Preserve the working ARM64 CUDA stack when checking image-generation dependencies.
---

Do not replace the DGX's working PyTorch/CUDA stack solely because pip check reports an NVIDIA wheel as unsupported on the platform.

**Why:** The existing ARM64 ComfyUI environment reported an unsupported nvidia-cusparselt-cu13 wheel, but CUDA tensor computation and an end-to-end SDXL generation both passed. Blindly reinstalling standard wheels could break GB10 support.

**How to apply:** Check declared ComfyUI requirements, imports, CUDA tensor execution and actual generation first. Treat packaging metadata warnings separately from demonstrated runtime failures. Keep the image service private to the Docker bridge rather than binding it to the public network.

Prefer permissively licensed image weights for the default workflow.

**Why:** FLUX.2 Klein 4B is Apache 2.0, while 9B uses a non-commercial license.
A larger variant is not automatically a suitable replacement for an application-building platform.

**How to apply:** Verify the current model license before upgrading; do not silently switch to non-commercial weights.