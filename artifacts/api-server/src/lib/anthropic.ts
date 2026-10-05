// Retained module name for existing capability imports. No API-key client.
export const REVIEW_MODEL = `Claude Code / ${process.env.CLAUDE_CODE_REVIEW_MODEL || "sonnet"} (on demand)`;
export const reviewAvailable = () => process.env.CLAUDE_CODE_REVIEW_ENABLED === "1";