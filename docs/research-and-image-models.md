# Local web research and image generation

## Research

The Compose `search` service runs SearXNG privately, with no published port.
`search_web` queries it using `SEARXNG_URL` and returns real URLs, titles and
snippets. The agent must fetch primary sources and cite actual retrieved URLs.
Blocked engines, empty results, invalid responses and timeouts are not replaced
with invented sources. Some engines may fail while others still return results.
Search queries leave the DGX to reach public search engines; do not put secrets
or private project content into a query.

Run `docker compose up -d search` before starting the upgraded Forge container.
Normal `docker compose up -d` starts it automatically.

## Images

Compose defaults `IMAGE_GEN_WORKFLOW` to `flux2-klein`. Non-Compose installations
retain SDXL unless they explicitly select the newer workflow.
The `generate_image` tool accepts `model: default | flux2-klein | sdxl`.
The new workflow requires ComfyUI, not AUTOMATIC1111.

Install these official weights into the existing ComfyUI models directory:

* `diffusion_models/flux-2-klein-4b-fp8.safetensors`:
  https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8
* `text_encoders/qwen_3_4b.safetensors`:
  https://huggingface.co/Comfy-Org/flux2-klein-4B
* `vae/flux2-vae.safetensors`:
  https://huggingface.co/Comfy-Org/flux2-dev

The distilled model uses four steps, CFG 1, a Flux2 scheduler and Flux2 latents.
SDXL settings must not be applied to it. Negative prompts are not applied by
the distilled workflow. Existing SDXL weights remain available; set
`IMAGE_GEN_WORKFLOW=sdxl` to restore the previous default.

Model licensing and official workflow references:
https://bfl.ai/models/flux-2-klein
https://docs.comfy.org/tutorials/flux/flux-2-klein

Verify generated artwork against the brief before integrating it. A raster
image is not an editable vector logo, even if it looks like vector artwork.
Run `pnpm --filter @workspace/api-server test:research-images` for automated checks.