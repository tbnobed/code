import http from "node:http";

export const BRIEF_BYTE_LIMIT = 3200;
export function boundedBrief(text: string) {
  const bytes = Buffer.from(text.trim(), "utf8");
  if (bytes.length <= BRIEF_BYTE_LIMIT) return text.trim();
  const suffix = "\n[Brief truncated; request missing evidence rather than guessing.]";
  return bytes.subarray(0, BRIEF_BYTE_LIMIT - Buffer.byteLength(suffix) - 4).toString("utf8").replace(/\uFFFD$/, "") + suffix;
}

/** Only the explicit shield-button review handler calls this function. */
export async function requestClaudeHelp(brief: string, signal?: AbortSignal): Promise<string> {
  if (!brief.trim()) throw new Error("The local model produced no useful brief; Claude was not contacted.");
  const body = JSON.stringify({ model: process.env.CLAUDE_CODE_REVIEW_MODEL || "sonnet", brief: boundedBrief(brief) });
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: process.env.CLAUDE_CODE_SOCKET || "/run/forge-claude/bridge.sock",
      path: "/review", method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, res => {
      let output = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        output += chunk;
        if (output.length > 32_000) req.destroy(new Error("Claude response exceeded the help budget."));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(output);
          if (res.statusCode !== 200) throw new Error(value.error || `Claude Code bridge HTTP ${res.statusCode}`);
          if (typeof value.text !== "string" || !value.text.trim()) throw new Error("Claude returned no advice.");
          resolve(value.text);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(260_000, () => req.destroy(new Error("Claude Code help timed out; no automatic retry.")));
    req.end(body);
  });
}