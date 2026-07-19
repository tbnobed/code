import type OpenAI from "openai";
import { eq, asc, sql } from "drizzle-orm";
import { db, sessionsTable, messagesTable, type Session } from "@workspace/db";
import { ollama } from "./ollama";
import { toolDefinitions, executeTool } from "./agent-tools";

const SYSTEM_PROMPT = `You are Forge, an autonomous coding agent running locally. You help the user build software by creating files, editing them, and running commands inside a sandboxed workspace directory.

Guidelines:
- Use your tools to do real work. Create actual files and run actual commands rather than only describing what to do.
- Work step by step: plan briefly, then execute with tools, then verify (e.g. run the code or list files).
- File paths are always relative to the workspace root.
- After finishing, summarize what you built and how to use it.
- If a command fails, read the error and fix the problem before giving up.`;

const MAX_ITERATIONS = 25;

type SendFn = (event: Record<string, unknown>) => void;

export async function runAgentTurn(session: Session, userContent: string, send: SendFn) {
  // Persist user message
  await db.insert(messagesTable).values({
    sessionId: session.id,
    role: "user",
    content: userContent,
  });

  // Build history for the model
  const history = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(asc(messagesTable.id));

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const toolCalls = m.toolCalls ? JSON.parse(m.toolCalls) : undefined;
      messages.push({
        role: "assistant",
        content: m.content || (toolCalls ? null : ""),
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.role === "tool" && m.toolCallId) {
      messages.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
    }
  }

  let newMessageCount = 1; // the user message

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await ollama.chat.completions.create({
      model: session.model,
      messages,
      tools: toolDefinitions,
      stream: true,
    });

    let text = "";
    // Accumulate tool calls across chunks
    const toolCallsAcc: { id: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        send({ type: "text", content: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: "", name: "", args: "" };
        if (tc.id) toolCallsAcc[idx].id = tc.id;
        if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCallsAcc[idx].args += tc.function.arguments;
      }
    }

    const toolCalls = toolCallsAcc.filter(Boolean);

    // Persist assistant message
    const assistantToolCalls = toolCalls.length
      ? toolCalls.map((tc, idx) => ({
          id: tc.id || `call_${Date.now()}_${idx}`,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        }))
      : undefined;

    await db.insert(messagesTable).values({
      sessionId: session.id,
      role: "assistant",
      content: text,
      toolCalls: assistantToolCalls ? JSON.stringify(assistantToolCalls) : null,
    });
    newMessageCount++;

    if (!assistantToolCalls) {
      break; // Model is done — plain text response
    }

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: assistantToolCalls,
    });

    // Execute each tool call
    for (const tc of assistantToolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        // fall through with empty args; tool will report the problem
      }
      send({
        type: "tool_call",
        name: tc.function.name,
        arguments: JSON.stringify(args),
      });

      const { result, isError } = await executeTool(
        session.workspacePath,
        tc.function.name,
        args,
      );
      send({ type: "tool_result", name: tc.function.name, result, isError });

      await db.insert(messagesTable).values({
        sessionId: session.id,
        role: "tool",
        content: result,
        toolCallId: tc.id,
      });
      newMessageCount++;

      messages.push({ role: "tool", content: result, tool_call_id: tc.id });
    }
  }

  await db
    .update(sessionsTable)
    .set({
      messageCount: sql`${sessionsTable.messageCount} + ${newMessageCount}`,
      updatedAt: new Date(),
    })
    .where(eq(sessionsTable.id, session.id));
}
