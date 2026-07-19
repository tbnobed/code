/**
 * Keep the system prompt and tool schemas alive on bounded context windows.
 *
 * Ollama silently truncates the FRONT of an over-long prompt, which deletes
 * the system message and tool definitions first — the model then "forgets"
 * it has tools and answers with prose implementation plans instead of
 * building. We trim conversation history ourselves, oldest-first, so the
 * prompt always fits and the front never gets cut.
 *
 * OLLAMA_NUM_CTX should match the context window the Ollama server actually
 * runs the model with (see OLLAMA_CONTEXT_LENGTH on the Ollama side).
 */

const CHARS_PER_TOKEN = 3.5; // conservative for code-heavy English
const RESERVED_TOKENS = 8192; // system prompt + tool schemas + generation room
const PER_MESSAGE_CAP = 12_000; // chars — one giant paste must not evict everything else

export const TRIM_NOTE =
  "[Note: older messages were trimmed to fit the context window. The workspace files are the source of truth — read them with tools when earlier context matters.]";

export function historyCharBudget(numCtxTokens: number): number {
  return Math.max(8_000, Math.floor((numCtxTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN));
}

interface MinimalMsg {
  role: string;
  content?: unknown;
}

/** Approximate cost of a message once serialized into the prompt. */
function msgCost(m: MinimalMsg): number {
  try {
    return JSON.stringify(m)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Keep the newest contiguous run of messages that fits the budget.
 * - The current turn's message (last entry) is always kept untruncated.
 * - Older oversized messages are capped at PER_MESSAGE_CAP chars.
 * - The kept window never starts with orphaned `tool` results (a tool
 *   message without its assistant tool_calls is an invalid transcript).
 * - When anything was dropped, a short note tells the model why.
 */
export function trimHistory<T extends MinimalMsg>(
  msgs: T[],
  budgetChars: number,
): Array<T | { role: "user"; content: string }> {
  if (msgs.length === 0) return [];
  const kept: T[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const isCurrentTurn = i === msgs.length - 1;
    let m = msgs[i];
    if (!isCurrentTurn && typeof m.content === "string" && m.content.length > PER_MESSAGE_CAP) {
      m = { ...m, content: m.content.slice(0, PER_MESSAGE_CAP) + "\n...[truncated]" };
    }
    const cost = msgCost(m);
    if (!isCurrentTurn && used + cost > budgetChars) break;
    kept.push(m);
    used += cost;
  }
  kept.reverse();
  while (kept.length && kept[0].role === "tool") kept.shift();
  if (kept.length < msgs.length) {
    return [{ role: "user" as const, content: TRIM_NOTE }, ...kept];
  }
  return kept;
}
