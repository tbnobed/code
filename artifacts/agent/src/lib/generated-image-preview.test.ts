import { test } from "node:test";
import assert from "node:assert/strict";
import { generatedImagePreview } from "./generated-image-preview";

test("each card resolves its recorded image version, never the mutable output path", () => {
  const first = { sha256: "a".repeat(64), path: `.forge-images/${"a".repeat(64)}.png` };
  const second = { sha256: "b".repeat(64), path: `.forge-images/${"b".repeat(64)}.png` };
  assert.equal(generatedImagePreview(`Generated image\nImage artifact: ${JSON.stringify(first)}`), first.path);
  assert.equal(generatedImagePreview(JSON.stringify({ result: `Image artifact: ${JSON.stringify(second)}` })), second.path);
  assert.equal(generatedImagePreview("Generated → logo.png"), null);
  assert.equal(generatedImagePreview('Image artifact: {"path":"../private.png","sha256":"bad"}'), null);
});