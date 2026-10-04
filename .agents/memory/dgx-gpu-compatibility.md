---
name: DGX GPU compatibility
description: Preserve the working ARM64 CUDA stack when checking image-generation dependencies.
---

Do not replace the DGX's working PyTorch/CUDA stack solely because pip check reports an NVIDIA wheel as unsupported on the platform.

**Why:** The existing ARM64 ComfyUI environment reported an unsupported nvidia-cusparselt-cu13 wheel, but CUDA tensor computation and an end-to-end SDXL generation both passed. Blindly reinstalling standard wheels could break GB10 support.

**How to apply:** Check declared ComfyUI requirements, imports, CUDA tensor execution and actual generation first. Treat packaging metadata warnings separately from demonstrated runtime failures. Keep the image service private to the Docker bridge rather than binding it to the public network.