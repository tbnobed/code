import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

const HASH_RE = /^[0-9a-f]{7,40}$/i;

// Checkpoint commits must never depend on host-level git config: containers
// frequently run without a writable HOME, so `git config --global` at boot
// can fail — and then every commit dies with "tell me who you are" while the
// callers swallow it as a warning. Identity is therefore injected per call.
// NB: compose passes `${GIT_USER_NAME:-}` — set but EMPTY. `??` would keep
// the empty string and git dies with "empty ident name (for <>) not allowed",
// so blank counts as unset here.
const GIT_IDENTITY = (process.env.GIT_USER_NAME || "").trim() || "Forge Agent";
const GIT_EMAIL = (process.env.GIT_USER_EMAIL || "").trim() || "forge-agent@localhost";
const GIT_ENV = {
  GIT_AUTHOR_NAME: GIT_IDENTITY,
  GIT_AUTHOR_EMAIL: GIT_EMAIL,
  GIT_COMMITTER_NAME: GIT_IDENTITY,
  GIT_COMMITTER_EMAIL: GIT_EMAIL,
  GIT_TERMINAL_PROMPT: "0", // never hang a server call on a credential prompt
  LC_ALL: "C", // force English git messages — the error-classification regexes depend on them
};

function git(dir: string, args: string[], maxBuffer = 10 * 1024 * 1024) {
  return run("git", ["-C", dir, ...args], {
    maxBuffer,
    env: { ...process.env, ...GIT_ENV },
  });
}

/** Initialize the workspace checkpoint repo if missing; safe to call repeatedly. */
export async function ensureRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  let isRepo = true;
  try {
    await fs.stat(path.join(dir, ".git"));
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    await git(dir, ["init", "-q"]);
    // Keep bulky/transient dirs out of checkpoints — but never stomp a
    // .gitignore the project already has.
    const gi = path.join(dir, ".gitignore");
    try {
      await fs.stat(gi);
    } catch {
      await fs.writeFile(gi, "node_modules/\n.env\n");
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "--allow-empty", "-m", "forge: initial checkpoint"]);
    return;
  }
  // Self-heal: repos initialized by older builds (or after an interrupted
  // init) can exist with ZERO commits — an unborn HEAD breaks every
  // rev-list/log/diff consumer (checkpoints tab, send-for-review). Give such
  // repos their root commit, capturing whatever is in the workspace now as
  // the session baseline.
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "--allow-empty", "-m", "forge: initial checkpoint"]);
  }
}

/**
 * Commit all current changes as a checkpoint.
 * Returns the new commit hash, or null if the workspace was clean.
 */
export async function commitTurn(dir: string, label: string) {
  await ensureRepo(dir);
  await git(dir, ["add", "-A"]);
  try {
    await git(dir, ["diff", "--cached", "--quiet"]);
    return null; // nothing changed
  } catch {
    // differences exist — commit them
  }
  const subject = `forge: ${label.replace(/\s+/g, " ").trim().slice(0, 72) || "checkpoint"}`;
  await git(dir, ["commit", "-q", "-m", subject]);
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export interface Checkpoint {
  hash: string;
  shortHash: string;
  subject: string;
  timestamp: string;
  filesChanged: number;
}

export async function listCheckpoints(dir: string): Promise<Checkpoint[]> {
  try {
    await fs.stat(path.join(dir, ".git"));
  } catch {
    return [];
  }
  let stdout: string;
  try {
    ({ stdout } = await git(dir, [
      "log",
      "-n",
      "50",
      "--shortstat",
      "--pretty=format:@@%H%x09%ct%x09%s",
    ]));
  } catch (err) {
    // A repo with no commits yet (unborn HEAD) has nothing to list — that is
    // an empty timeline, not a server error.
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not have any commits|bad default revision|unknown revision|ambiguous argument/i.test(msg)) {
      return [];
    }
    throw err;
  }
  const out: Checkpoint[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) {
      const [hash, ct, ...rest] = line.slice(2).split("\t");
      out.push({
        hash,
        shortHash: hash.slice(0, 7),
        subject: rest.join("\t").replace(/^forge: /, ""),
        timestamp: new Date(Number(ct) * 1000).toISOString(),
        filesChanged: 0,
      });
    } else {
      const m = line.match(/(\d+) files? changed/);
      if (m && out.length) out[out.length - 1].filesChanged = Number(m[1]);
    }
  }
  return out;
}

/** Unified diff (patch + stat) for one checkpoint, size-capped. */
export async function diffCheckpoint(dir: string, hash: string) {
  if (!HASH_RE.test(hash)) throw new Error("Invalid checkpoint id");
  const { stdout } = await git(dir, ["show", hash, "--patch", "--stat", "--no-color"], 5 * 1024 * 1024);
  return stdout.length > 200_000 ? stdout.slice(0, 200_000) + "\n...[diff truncated]" : stdout;
}

/**
 * Restore the workspace to a checkpoint's state — recorded as a NEW commit
 * on top of history (never rewrites it), so the user can jump back forward.
 * Returns the new commit hash, or null if already at that state.
 */
export async function revertTo(dir: string, hash: string) {
  if (!HASH_RE.test(hash)) throw new Error("Invalid checkpoint id");
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  const head = stdout.trim();
  await git(dir, ["reset", "--hard", hash]);
  // Remove files created after the target checkpoint (but never installs).
  await git(dir, ["clean", "-fd", "-e", "node_modules"]);
  // Move HEAD back to the tip while keeping the restored working tree,
  // then commit that state forward.
  await git(dir, ["reset", "--soft", head]);
  await git(dir, ["add", "-A"]);
  try {
    await git(dir, ["diff", "--cached", "--quiet"]);
    return null; // already identical
  } catch {
    // differences exist
  }
  await git(dir, ["commit", "-q", "-m", `forge: revert to ${hash.slice(0, 7)}`]);
  const r = await git(dir, ["rev-parse", "HEAD"]);
  return r.stdout.trim();
}

/**
 * Whole-session diff, size-capped. Workspaces are created empty, so the true
 * session baseline is git's EMPTY TREE, not the root commit: healed legacy
 * repos (unborn HEAD fixed after the fact) fold all existing work into their
 * root commit, and diffing root..HEAD there shows nothing even though the
 * session built everything. For normal sessions the root checkpoint has an
 * empty tree, so both baselines produce identical output. Callers should
 * commit pending manual changes first so the diff includes them.
 */
export async function diffSinceStart(dir: string) {
  let emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // sha1 empty tree
  try {
    // Derive it for the repo's object format (sha256 repos hash differently).
    const { stdout } = await git(dir, ["hash-object", "-t", "tree", "/dev/null"]);
    if (stdout.trim()) emptyTree = stdout.trim();
  } catch {
    // fall back to the sha1 constant
  }
  try {
    // The root .gitignore is seeded by ensureRepo, not authored in the session:
    // when the diff touches nothing else, there is no reviewable work yet.
    const { stdout: names } = await git(dir, ["diff", "--name-only", emptyTree, "HEAD"]);
    const realFiles = names.split("\n").filter((n) => n.trim() && n.trim() !== ".gitignore");
    if (realFiles.length === 0) return "";
    const { stdout } = await git(
      dir,
      ["diff", emptyTree, "HEAD", "--patch", "--stat", "--no-color"],
      32 * 1024 * 1024,
    );
    return stdout.length > 200_000 ? stdout.slice(0, 200_000) + "\n...[diff truncated]" : stdout;
  } catch (err) {
    // A diff bigger than the buffer should degrade to a clear message, not a
    // crash-y ENOBUFS error surfacing in the stream.
    if ((err as NodeJS.ErrnoException)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(
        "The session diff is too large to review (>32MB). Review earlier, or start a fresh session for new work.",
      );
    }
    // No resolvable HEAD (no commits yet / damaged ref): there is nothing to
    // diff — report "no changes" instead of leaking raw git stderr upstream.
    const msg = err instanceof Error ? err.message : String(err);
    if (/unknown revision|ambiguous argument|bad revision|does not have any commits/i.test(msg)) {
      return "";
    }
    throw err;
  }
}

/** Newline-separated list of files under checkpoint control. */
export async function listTrackedFiles(dir: string) {
  const { stdout } = await git(dir, ["ls-files"]);
  return stdout.trim();
}
