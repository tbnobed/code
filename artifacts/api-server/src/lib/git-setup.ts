import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger";

const run = promisify(execFile);

export const githubEnabled = Boolean(process.env.GITHUB_TOKEN);

/**
 * Reads $GITHUB_TOKEN at use time; declines (exit 1) when unset. Shared by
 * the boot-time global config and per-push `-c` injection (which must reset
 * the helper chain first to neutralize workspace-planted helpers).
 */
export const GITHUB_CREDENTIAL_HELPER = `!f() { test -n "$GITHUB_TOKEN" || return 1; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f`;

/**
 * Configure git for the agent, if git is installed.
 * When GITHUB_TOKEN is set, authenticate HTTPS GitHub remotes via a
 * credential helper that reads the token from the environment at use time —
 * the token is never written to disk or embedded in remote URLs.
 */
export async function setupGit() {
  try {
    await run("git", ["--version"]);
  } catch {
    if (githubEnabled) {
      logger.warn("GITHUB_TOKEN is set but git is not installed; GitHub sync disabled");
    }
    return;
  }

  try {
    await configureGit();
  } catch (err) {
    logger.error({ err }, "git configuration failed; GitHub sync disabled");
  }
}

async function configureGit() {
  const config: [string, string][] = [
    ["init.defaultBranch", "main"],
    // Blank env (compose `${VAR:-}`) must not write an empty ident into
    // global config — that poisons every git commit in the container.
    ["user.name", (process.env.GIT_USER_NAME || "").trim() || "Forge Agent"],
    ["user.email", (process.env.GIT_USER_EMAIL || "").trim() || "forge-agent@localhost"],
    // Never prompt for credentials interactively (would hang run_command)
    ["core.askPass", ""],
  ];
  // Installed unconditionally: tokens now arrive per-session via env (the
  // owner's PAT, or the legacy server-wide GITHUB_TOKEN). With no token the
  // helper declines and git fails cleanly instead of hanging on a prompt.
  config.push(["credential.https://github.com.helper", GITHUB_CREDENTIAL_HELPER]);
  for (const [key, value] of config) {
    await run("git", ["config", "--global", key, value]);
  }
  logger.info({ github: githubEnabled }, "git configured for agent workspaces");
}
