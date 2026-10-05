import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveGeneratedImage, imageFingerprint } from "./generated-image-artifact";

test("regenerating one output path preserves distinct historical previews and fingerprints", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-image-versions-"));
  try {
    const first = await saveGeneratedImage(dir, "logo.png", Buffer.from("first image"));
    const second = await saveGeneratedImage(dir, "logo.png", Buffer.from("second image"));
    assert.notEqual(first.path, second.path);
    assert.equal(await fs.readFile(path.join(dir, first.path), "utf8"), "first image");
    assert.equal(await fs.readFile(path.join(dir, second.path), "utf8"), "second image");
    assert.equal(await fs.readFile(path.join(dir, "logo.png"), "utf8"), "second image");
    assert.equal(imageFingerprint(await fs.readFile(path.join(dir, second.path))), second.sha256);
    assert.equal(second.identicalToPrevious, false);
    const duplicate = await saveGeneratedImage(dir, "logo.png", Buffer.from("second image"));
    assert.equal(duplicate.identicalToPrevious, true);
    await assert.rejects(saveGeneratedImage(dir, "../escape.png", Buffer.from("no")), /workspace|outside|escape/i);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});