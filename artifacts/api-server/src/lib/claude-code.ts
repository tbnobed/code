import http from "node:http";
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";

export const claudeCodeEnabled = () => process.env.AGENT_BACKEND === "claude-code";
export const claudeCodeModels = ["sonnet", "opus", "haiku"].map(m => `claude-code/${m}`);
export const effectiveClaudeModel = (model: string) => claudeCodeModels.includes(model)
  ? model : `claude-code/${process.env.CLAUDE_CODE_MODEL || "sonnet"}`;

export function decodeDecision(value: unknown, tools: OpenAI.Chat.Completions.ChatCompletionTool[]) {
  const allowed = new Set(tools.filter(t => t.type === "function").map(t => t.function.name));
  const data = value as { content?: unknown; tool_calls?: unknown };
  if (!data || typeof data.content !== "string" || !Array.isArray(data.tool_calls) || data.tool_calls.length > 8) {
    throw new Error("Claude Code returned an invalid decision.");
  }
  const calls = data.tool_calls.map((call: { name?: unknown; arguments?: unknown }, index: number) => {
    if (!call || typeof call.name !== "string" || !allowed.has(call.name) || typeof call.arguments !== "string") {
      throw new Error("Claude Code returned an unsupported tool.");
    }
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid Claude Code tool arguments.");
    return { index, id: `claude_${randomUUID()}`, type: "function" as const, function: { name: call.name, arguments: call.arguments } };
  });
  if (!data.content.trim() && !calls.length) throw new Error("Claude Code returned an empty decision.");
  return { content: data.content, tool_calls: calls };
}

export async function* claudeCodeStream(
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
  signal?: AbortSignal,
): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
  const selected = effectiveClaudeModel(model).split("/")[1];
  const body = JSON.stringify({ model: selected, messages, tools });
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = http.request({
      socketPath: process.env.CLAUDE_CODE_SOCKET || "/run/forge-claude/bridge.sock",
      path: "/completion", method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, res => {
      let output = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        output += chunk;
        if (output.length > 2_000_000) req.destroy(new Error("Claude Code response exceeded its size limit."));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(output);
          if (res.statusCode !== 200) throw new Error(value.error || `Claude Code bridge HTTP ${res.statusCode}`);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(260_000, () => req.destroy(new Error("Claude Code bridge timed out.")));
    req.end(body);
  });
  const delta = decodeDecision(result, tools);
  yield { id: randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    model: `claude-code/${selected}`, choices: [{ index: 0, delta, finish_reason: null }] };
}