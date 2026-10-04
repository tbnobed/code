import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { create, act } from "react-test-renderer";
import { useChatStream } from "../src/hooks/use-chat-stream";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("switching sessions aborts old streams and rejects late events and finalizers", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array> }[] = [];
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    // Deliberately ignore abort to reproduce buffered packets arriving late.
    requests.push({ signal: options.signal as AbortSignal, controller });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  let current!: ReturnType<typeof useChatStream>;
  let oldDone = 0, newDone = 0, newTools = 0;
  function Probe({ id }: { id: number }) {
    current = useChatStream({
      sessionId: id,
      onDone: id === 1 ? () => oldDone++ : () => newDone++,
      onToolResult: () => newTools++,
    });
    return null;
  }
  const emit = (index: number, event: unknown) => requests[index].controller.enqueue(
    new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
  );
  let root!: ReturnType<typeof create>;
  try {
    await act(async () => { root = create(<Probe id={1} />); });
    let first!: Promise<void>;
    await act(async () => { first = current.sendChat("Original request", { architect: true }); });
    await act(async () => {
      emit(0, { type: "text", content: "Old session output" });
      emit(0, { type: "tool_progress", name: "create_file", arguments: "old code" });
      emit(0, { type: "error", message: "old error" });
    });
    assert.equal(current.streamingText, "Old session output");
    assert.equal(current.isArchitectTurn, true);
    await act(async () => { root.update(<Probe id={2} />); });
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(current.isStreaming, false);
    assert.equal(current.streamingText, "");
    assert.equal(current.submittedContent, "");
    assert.equal(current.activeToolCall, null);
    assert.equal(current.error, null);
    assert.equal(current.isArchitectTurn, false);
    let second!: Promise<void>;
    await act(async () => { second = current.sendChat("New request"); });
    await act(async () => {
      emit(0, { type: "text", content: "Late old text" });
      await first;
    });
    assert.equal(current.isStreaming, true, "old finally must not clear the new stream");
    assert.equal(current.submittedContent, "New request");
    assert.equal(current.streamingText, "");
    assert.equal(oldDone, 0);
    assert.equal(newDone, 0);
    assert.equal(newTools, 0);
    await act(async () => {
      emit(1, { type: "text", content: "Correct new response" });
    });
    assert.equal(current.streamingText, "Correct new response");
    await act(async () => {
      emit(1, { type: "done" });
      requests[1].controller.close();
      await second;
    });
    assert.equal(newDone, 1);
    assert.equal(oldDone, 0);
  } finally {
    await act(async () => { root?.unmount(); });
    globalThis.fetch = originalFetch;
  }
});

test("workspace identity is keyed by session, isolating editor and attachment state too", () => {
  const source = fs.readFileSync("src/pages/ForgeLayout.tsx", "utf8");
  assert.match(source, /<ForgeWorkspace key=\{activeSessionId\} sessionId=\{activeSessionId\}/);
});