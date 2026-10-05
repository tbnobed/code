// Read-only probes through the same signed route used by the browser.
// No Forge cookies, credentials, arbitrary URLs, or external redirects.
export type PreviewEvidence = { ok: boolean; summary: string; checked: number };

export async function probeSignedPreview(
  origin: string, previewPath: string, signal?: AbortSignal,
): Promise<PreviewEvidence> {
  const base = new URL(previewPath, origin);
  if (base.origin !== origin || !/^\/api\/sessions\/\d+\/preview\/[A-Za-z0-9_~-]+\/$/.test(base.pathname)) {
    return { ok: false, summary: "Invalid signed preview path.", checked: 0 };
  }
  let checked = 0;
  const safePath = (url: URL) => url.pathname.replace(base.pathname, "/");
  const request = async (initial: URL) => {
    let url = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.origin !== origin || !url.pathname.startsWith(base.pathname)) throw new Error("Preview URL escapes its signed sandbox.");
      const timeout = AbortSignal.timeout(15_000);
      const response = await fetch(url, { redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      checked++;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Preview redirect has no location.");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Preview ${safePath(url)} returned HTTP ${response.status}.`);
      }
      return { response, url };
    }
    throw new Error("Preview redirect loop.");
  };
  try {
    const { response, url } = await request(base);
    if (!response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel();
      return { ok: true, summary: "Signed preview HTTP response passed; browser behavior was not tested.", checked };
    }
    let html = "";
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          html += decoder.decode(part.value, { stream: true });
          if (html.length > 1_000_000) throw new Error("Preview HTML exceeds verification limit.");
        }
      } finally { await reader.cancel(); }
    }
    if (!html.trim()) throw new Error("Preview returned empty HTML.");
    const assets = new Set<string>();
    for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const tag = match[0];
      if (match[1].toLowerCase() === "link" && !/\brel\s*=\s*["'](?:stylesheet|modulepreload)["']/i.test(tag)) continue;
      const attribute = tag.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!attribute) continue;
      const asset = new URL(attribute.replaceAll("&amp;", "&"), url);
      if (asset.origin !== origin) continue; // Don't fetch third-party resources.
      if (!asset.pathname.startsWith(base.pathname)) throw new Error("A script or stylesheet escapes the signed preview base.");
      assets.add(asset.href);
    }
    for (const asset of [...assets].slice(0, 12)) {
      const { response: resource, url: assetUrl } = await request(new URL(asset));
      const type = resource.headers.get("content-type") || "";
      await resource.body?.cancel();
      if (type.includes("text/html")) throw new Error(`Preview asset ${safePath(assetUrl)} returned HTML instead of script/style content.`);
    }
    return { ok: true, summary: `Signed preview HTML and ${Math.min(assets.size, 12)} local entry assets passed. This is an HTTP smoke check, not a browser or application-feature test.`, checked };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    // Never expose signed URLs from fetch errors or project-controlled paths.
    const summary = (error instanceof Error ? error.message : "Preview request failed")
      .replaceAll(base.pathname.slice(0, -1), "[preview]")
      .replace(/https?:\/\/\S+/g, "[URL]");
    return { ok: false, summary, checked };
  }
}