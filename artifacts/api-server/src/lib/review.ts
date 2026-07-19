import { db, messagesTable, sessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getAnthropic, REVIEW_MODEL } from "./anthropic";
import { diffSinceStart, listTrackedFiles } from "./workspace-git";

type SendFn = (event: Record<string, unknown>) => void;

/** Structural — matches the session row the routes already hold. */
interface ReviewableSession {
  id: number;
  title: string;
  workspacePath: string;
}

const REVIEW_SYSTEM_PROMPT = `You are a principal engineer reviewing work produced by a local coding agent. You receive the workspace file list and the full unified diff of everything this session changed.

Structure your review exactly as:
1. **Verdict** — one line: SHIP / SHIP WITH FIXES / NEEDS WORK, plus a one-sentence justification.
2. **Critical** — bugs, security holes, data-loss risks, broken behavior. Cite file paths (and hunks) from the diff. If none, write "None found."
3. **Improvements** — concrete, high-value changes worth doing now.
4. **Nitpicks** — minor style/consistency notes, compressed.

Rules:
- Review ONLY what the diff shows; never invent context you cannot see. If something important looks truncated or missing, say so.
- Be specific: name files, quote the problematic code, and propose the fix in a sentence or short snippet.
- No praise padding, no restating the diff, no generic advice.
- Tight markdown. Keep the whole review under 600 words unless critical issues genuinely demand more.`;

function classifyAnthropicError(err: unknown): Error {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) {
    return new Error("Anthropic rejected the credentials — check ANTHROPIC_API_KEY on the server.");
  }
  if (status === 404) {
    return new Error(
      `Review model "${REVIEW_MODEL}" was not found — set ANTHROPIC_REVIEW_MODEL to a model your key can access.`,
    );
  }
  if (status === 429) {
    return new Error("Anthropic rate limit hit — try again in a moment.");
  }
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(err.message)) {
    return new Error("Could not reach the Anthropic API — check the server's outbound network access.");
  }
  return err instanceof Error ? err : new Error("Review failed");
}

/**
 * "Send for review": ship the session's whole diff (initial checkpoint -> now)
 * to Claude and stream the review back over the normal SSE contract. The
 * finished review is persisted as an assistant message so it lives in the
 * session history like any other turn.
 */
export async function runReviewTurn(
  session: ReviewableSession,
  send: SendFn,
  signal?: AbortSignal,
) {
  const diff = await diffSinceStart(session.workspacePath);
  if (!diff.trim()) {
    send({
      type: "error",
      message: "Nothing to review yet — the workspace has no changes since the session started.",
    });
    return;
  }
  const files = await listTrackedFiles(session.workspacePath).catch(() => "");
  const fileList = files.split("\n").slice(0, 300).join("\n");

  const userContent = [
    `Session: ${session.title}`,
    `\nWorkspace files:\n${fileList || "(unavailable)"}`,
    `\nFull unified diff of all work in this session (initial checkpoint -> current state):\n\n${diff}`,
  ].join("\n");

  let text = "";
  let aborted = false;
  let persisted = false;
  try {
    try {
      const stream = getAnthropic().messages.stream(
        {
          model: REVIEW_MODEL,
          max_tokens: 8192,
          system: REVIEW_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
          send({ type: "text", content: event.delta.text });
        }
      }
    } catch (err) {
      if (signal?.aborted) aborted = true;
      else throw classifyAnthropicError(err);
    }

    if (text.trim()) {
      const body = `## External review — ${REVIEW_MODEL}\n\n${text.trim()}`;
      await db.insert(messagesTable).values({
        sessionId: session.id,
        role: "assistant",
        content: aborted ? `${body}\n\n[Stopped by user]` : body,
      });
      persisted = true;
    }
  } finally {
    if (persisted) {
      await db
        .update(sessionsTable)
        .set({
          messageCount: sql`${sessionsTable.messageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(sessionsTable.id, session.id));
    }
  }
}
