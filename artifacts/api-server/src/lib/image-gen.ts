/**
 * Local image generation via a Stable Diffusion server running on the host.
 *
 * Two API dialects are supported and auto-detected:
 *   - AUTOMATIC1111-compatible WebUIs (A1111, SD.Next, Forge): POST /sdapi/v1/txt2img
 *   - ComfyUI: graph POST /prompt + /history polling + /view download
 *
 * Opt-in like the Claude review feature: when IMAGE_GEN_URL is unset the
 * generate_image tool is never registered and the capability reports false.
 * All ImageGenError messages are user-safe (surfaced as tool results in chat).
 */

export class ImageGenError extends Error {}

type Provider = "a1111" | "comfyui";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Read config lazily so tests (and future config reloads) see fresh env. */
function cfg() {
  return {
    url: (process.env.IMAGE_GEN_URL ?? "").trim().replace(/\/+$/, ""),
    provider: (process.env.IMAGE_GEN_PROVIDER ?? "auto").trim().toLowerCase(),
    model: (process.env.IMAGE_GEN_MODEL ?? "").trim(),
    steps: intEnv("IMAGE_GEN_STEPS", 20, 1, 150),
    timeoutMs: intEnv("IMAGE_GEN_TIMEOUT_MS", 180_000, 10_000, 900_000),
  };
}

export function imageGenAvailable(): boolean {
  return cfg().url.length > 0;
}

/** Clamp to the sane SD range and round to a multiple of 8. */
export function clampDimension(v: unknown, fallback = 1024): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(Math.min(2048, Math.max(256, n)) / 8) * 8;
}

function combineSignals(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const signals = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

function classifyFetchError(err: unknown, url: string, timeoutMs: number): ImageGenError {
  if (err instanceof ImageGenError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ImageGenError(
      `Image generation timed out after ${Math.round(timeoutMs / 1000)}s. Large models can be slow — raise IMAGE_GEN_TIMEOUT_MS or use a faster checkpoint.`,
    );
  }
  return new ImageGenError(
    `Image server unreachable at ${url} — check IMAGE_GEN_URL and that the Stable Diffusion server is running (A1111 needs the --api flag).`,
  );
}

// ---------------------------------------------------------------------------
// Provider detection

const detectionCache = new Map<string, Provider>();

async function probe(base: string, path: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function detectProvider(base: string): Promise<Provider> {
  const { provider } = cfg();
  if (provider === "a1111" || provider === "comfyui") return provider;
  const cached = detectionCache.get(base);
  if (cached) return cached;
  if (await probe(base, "/sdapi/v1/options")) {
    detectionCache.set(base, "a1111");
    return "a1111";
  }
  if (await probe(base, "/system_stats")) {
    detectionCache.set(base, "comfyui");
    return "comfyui";
  }
  throw new ImageGenError(
    `No AUTOMATIC1111 or ComfyUI API found at ${base}. For A1111 launch with --api; for ComfyUI check the port (default 8188). Set IMAGE_GEN_PROVIDER to skip auto-detection.`,
  );
}

// ---------------------------------------------------------------------------
// A1111

async function generateA1111(
  base: string,
  opts: Required<Pick<GenerateImageOptions, "prompt" | "width" | "height">> &
    Pick<GenerateImageOptions, "negativePrompt">,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const { steps, timeoutMs, model } = cfg();
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    negative_prompt: opts.negativePrompt ?? "",
    width: opts.width,
    height: opts.height,
    steps,
  };
  if (model) {
    body.override_settings = { sd_model_checkpoint: model };
    body.override_settings_restore_afterwards = true;
  }
  let r: Response;
  try {
    r = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combineSignals(signal, timeoutMs),
    });
  } catch (err) {
    throw classifyFetchError(err, base, timeoutMs);
  }
  if (!r.ok) {
    const text = (await r.text().catch(() => "")).slice(0, 300);
    throw new ImageGenError(`Image server error (HTTP ${r.status}): ${text || "no details"}`);
  }
  const data = (await r.json().catch(() => null)) as { images?: string[] } | null;
  const b64 = data?.images?.[0];
  if (!b64) throw new ImageGenError("Image server returned no image data.");
  return Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64");
}

// ---------------------------------------------------------------------------
// ComfyUI

async function comfyFirstCheckpoint(base: string): Promise<string> {
  let r: Response;
  try {
    r = await fetch(`${base}/object_info/CheckpointLoaderSimple`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw classifyFetchError(err, base, 10_000);
  }
  if (!r.ok) throw new ImageGenError(`ComfyUI object_info failed (HTTP ${r.status}).`);
  const data = (await r.json().catch(() => null)) as Record<string, any> | null;
  const name = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]?.[0];
  if (typeof name !== "string" || !name) {
    throw new ImageGenError(
      "ComfyUI has no checkpoints installed — add a model or set IMAGE_GEN_MODEL.",
    );
  }
  return name;
}

function comfyGraph(
  ckpt: string,
  opts: Required<Pick<GenerateImageOptions, "prompt" | "width" | "height">> &
    Pick<GenerateImageOptions, "negativePrompt">,
  steps: number,
) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 48),
        steps,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: opts.width, height: opts.height, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: opts.prompt, clip: ["4", 1] } },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: opts.negativePrompt ?? "", clip: ["4", 1] },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "forge" } },
  };
}

async function generateComfy(
  base: string,
  opts: Required<Pick<GenerateImageOptions, "prompt" | "width" | "height">> &
    Pick<GenerateImageOptions, "negativePrompt">,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const { steps, timeoutMs, model } = cfg();
  const ckpt = model || (await comfyFirstCheckpoint(base));
  const deadline = Date.now() + timeoutMs;

  let submit: Response;
  try {
    submit = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: comfyGraph(ckpt, opts, steps), client_id: "forge-agent" }),
      signal: combineSignals(signal, 30_000),
    });
  } catch (err) {
    throw classifyFetchError(err, base, timeoutMs);
  }
  if (!submit.ok) {
    const text = (await submit.text().catch(() => "")).slice(0, 300);
    throw new ImageGenError(
      `ComfyUI rejected the generation request (HTTP ${submit.status}): ${text || "no details"}. The checkpoint "${ckpt}" may not exist.`,
    );
  }
  const { prompt_id: promptId } = (await submit.json().catch(() => ({}))) as {
    prompt_id?: string;
  };
  if (!promptId) throw new ImageGenError("ComfyUI did not return a prompt id.");

  // Poll history until the job completes or the deadline passes.
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ImageGenError("Image generation was cancelled.");
    await new Promise((r) => setTimeout(r, 1_500));
    let hist: Response;
    try {
      hist = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      continue; // transient poll failure — keep trying until the deadline
    }
    if (!hist.ok) continue;
    const data = (await hist.json().catch(() => null)) as Record<string, any> | null;
    const entry = data?.[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const detail = JSON.stringify(entry.status?.messages ?? []).slice(0, 300);
      throw new ImageGenError(`ComfyUI generation failed: ${detail}`);
    }
    const outputs = entry.outputs ?? {};
    for (const node of Object.values(outputs) as any[]) {
      const img = node?.images?.[0];
      if (img?.filename) {
        const params = new URLSearchParams({
          filename: img.filename,
          subfolder: img.subfolder ?? "",
          type: img.type ?? "output",
        });
        let view: Response;
        try {
          view = await fetch(`${base}/view?${params}`, { signal: AbortSignal.timeout(30_000) });
        } catch (err) {
          throw classifyFetchError(err, base, timeoutMs);
        }
        if (!view.ok) throw new ImageGenError(`ComfyUI image download failed (HTTP ${view.status}).`);
        return Buffer.from(await view.arrayBuffer());
      }
    }
  }
  throw new ImageGenError(
    `Image generation timed out after ${Math.round(timeoutMs / 1000)}s. Large models can be slow — raise IMAGE_GEN_TIMEOUT_MS or use a faster checkpoint.`,
  );
}

// ---------------------------------------------------------------------------
// Public API

export interface GenerateImageOptions {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
}

export async function generateImage(
  opts: GenerateImageOptions,
  signal?: AbortSignal,
): Promise<{ png: Buffer; width: number; height: number; provider: Provider }> {
  const { url } = cfg();
  if (!url) throw new ImageGenError("Image generation is not configured (IMAGE_GEN_URL is unset).");
  const width = clampDimension(opts.width);
  const height = clampDimension(opts.height);
  const provider = await detectProvider(url);
  const full = { prompt: opts.prompt, negativePrompt: opts.negativePrompt, width, height };
  const png =
    provider === "a1111"
      ? await generateA1111(url, full, signal)
      : await generateComfy(url, full, signal);
  if (png.length === 0) throw new ImageGenError("Image server returned an empty image.");
  return { png, width, height, provider };
}
