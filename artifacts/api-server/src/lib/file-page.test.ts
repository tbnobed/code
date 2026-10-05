import { test } from "node:test";
import assert from "node:assert/strict";
import { filePage } from "./file-page";

test("honors the exact offset/limit form used by the failed IPAM repair", () => {
  const source = Array.from({ length: 1649 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = filePage(source, { offset: "1250.0", limit: "100.0" });
  assert.match(result, /1250: line 1250/);
  assert.match(result, /1295: line 1295/);
  assert.doesNotMatch(result, /\n1: line 1\n/);
  assert.match(result, /start_line=1350/);
  assert.match(filePage(source, { start_line: 1649, end_line: 1649 }), /End of file/);
  assert.match(filePage(source, { start_line: 1650 }), /past the end/);
  assert.throws(() => filePage(source, { start_line: -1 }), /positive integer/);
});

test("budget truncation always reports the real next unread line", () => {
  const source = Array.from({ length: 300 }, () => "x".repeat(100)).join("\n");
  const result = filePage(source, {});
  const next = Number(result.match(/start_line=(\d+)/)![1]);
  assert.match(result, new RegExp(`\\n${next - 1}: `));
  assert.doesNotMatch(result, new RegExp(`\\n${next}: `));
  assert.ok(result.length < 11000);
  assert.match(filePage("x".repeat(15000), {}), /targeted search/);
});