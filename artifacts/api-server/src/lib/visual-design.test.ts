import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveVisualDesign, visualStatus } from "./visual-design";

test("visual styles persist into production source, merge, remove and reset", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-design-"));
  try {
    await fs.writeFile(path.join(dir, "index.html"), "<html><head></head><body><h1>Hello</h1></body></html>");
    assert.equal((await visualStatus(dir)).supported, true);
    const first = await saveVisualDesign(dir, { selector: "h1", styles: { color: "#ff0000" } });
    assert.ok(first.checkpoint);
    assert.match(await fs.readFile(path.join(dir, "index.html"), "utf8"), /forge-design.css/);
    await saveVisualDesign(dir, { selector: "h1", styles: { padding: "12px" } });
    assert.deepEqual((await visualStatus(dir)).rules.h1, { color: "#ff0000", padding: "12px" });
    await saveVisualDesign(dir, { selector: "h1", styles: { color: "" } });
    assert.deepEqual((await visualStatus(dir)).rules.h1, { padding: "12px" });
    await assert.rejects(saveVisualDesign(dir, { selector: "h1", styles: { color: "red;display:none" } }), /Unsupported/);
    await saveVisualDesign(dir, null);
    assert.deepEqual((await visualStatus(dir)).rules, {});
    assert.equal((await fs.readFile(path.join(dir, "index.html"), "utf8")).match(/forge-design.css/g)?.length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("Next layout keeps directives and gains a build-time CSS import", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-next-design-"));
  try {
    await fs.mkdir(path.join(dir, "src/app"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/app/layout.tsx"), '"use client";\nexport default function Layout(){return null}');
    await saveVisualDesign(dir, { selector: "body", styles: { "background-color": "#111" } });
    const source = await fs.readFile(path.join(dir, "src/app/layout.tsx"), "utf8");
    assert.ok(source.startsWith('"use client"'));
    assert.match(source, /import "..\/..\/forge-design.css"/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});