import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "./web-search";
import { fluxKleinGraph } from "./image-workflows";

test("search returns genuine URLs, removes duplicates/unsafe links, and marks partial responses", async () => {
  const original = globalThis.fetch;
  const previous = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = "http://search:8080";
  try {
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      assert.equal(u.pathname, "/search");
      assert.equal(u.searchParams.get("q"), "test & source");
      return Response.json({ results: [
        null, { url: "javascript:alert(1)" }, { url: "https://user:secret@example.com" },
        { url: "https://example.com/docs", title: "Official", content: "<b>Source</b>" },
        { url: "https://example.com/docs", title: "Duplicate" },
      ], unresponsive_engines: [["example-engine", "timeout"]] });
    };
    const r = await searchWeb("test & source");
    assert.deepEqual(r.results, [{ title: "Official", url: "https://example.com/docs", snippet: "Source" }]);
    assert.equal(r.partial, true);
    assert.match(r.instruction, /untrusted/);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previous;
  }
});

test("search errors are explicit, never invented results", async () => {
  const original = globalThis.fetch;
  const previous = process.env.SEARXNG_URL;
  try {
    delete process.env.SEARXNG_URL;
    await assert.rejects(searchWeb("models"), /not configured/);
    process.env.SEARXNG_URL = "http://search:8080";
    await assert.rejects(searchWeb(" "), /1–500/);
    globalThis.fetch = async () => new Response("blocked", { status: 403 });
    await assert.rejects(searchWeb("models"), /HTTP 403/);
    globalThis.fetch = async () => Response.json({ results: [] });
    await assert.rejects(searchWeb("models"), /no usable results/);
    globalThis.fetch = async () => Response.json(null);
    await assert.rejects(searchWeb("models"), /invalid JSON/);
    globalThis.fetch = async () => { throw new Error("private service detail"); };
    await assert.rejects(searchWeb("models", AbortSignal.abort()), /cancelled/);
    await assert.rejects(searchWeb("models"), /could not be reached/);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previous;
  }
});

test("Klein uses the official distilled topology, not SDXL guidance or latent format", () => {
  const g = fluxKleinGraph("Brand logo", 1024, 768);
  assert.equal(g["9"].inputs.steps, 4);
  assert.equal(g["6"].inputs.cfg, 1);
  assert.equal(g["10"].class_type, "EmptyFlux2LatentImage");
  assert.equal(g["2"].inputs.type, "flux2");
  assert.equal(g["4"].inputs.text, "Brand logo");
  assert.equal(g["10"].inputs.height, 768);
  assert.equal(g["13"].class_type, "SaveImage");
  for (const node of Object.values(g)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(String(value[0]) in g, "all graph links must exist");
    }
  }
});