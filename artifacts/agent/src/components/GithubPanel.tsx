import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Github, Loader2, UploadCloud } from "lucide-react";
import { getGetSessionQueryKey } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  githubApi,
  GITHUB_ACCOUNT_KEY,
  type GithubAccountStatus,
} from "@/components/GithubSettingsDialog";

const inputCls =
  "font-mono text-sm bg-background border-input focus-visible:ring-primary rounded-sm h-9 transition-colors";
const labelCls = "font-mono text-[10px] uppercase tracking-widest text-muted-foreground";

type RepoEntry = { fullName: string; private: boolean; pushedAt: string | null };

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 64) || "forge-session"
  );
}

interface GithubPanelProps {
  sessionId: number;
  sessionTitle: string;
  githubRepo: string | null;
  githubAutopush: boolean;
}

/**
 * Per-session GitHub controls: one-click repo create/link, manual push, and
 * the auto-push-on-checkpoint toggle.
 */
export default function GithubPanel({
  sessionId,
  sessionTitle,
  githubRepo,
  githubAutopush,
}: GithubPanelProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [linkTarget, setLinkTarget] = useState("");
  const queryClient = useQueryClient();

  const sessionKey = getGetSessionQueryKey(sessionId);
  const refreshSession = () => queryClient.invalidateQueries({ queryKey: sessionKey });
  const fail = (err: Error) => {
    setNotice(null);
    setError(err.message);
  };
  const ok = (msg: string) => {
    setError(null);
    setNotice(msg);
  };

  const { data: account } = useQuery({
    queryKey: GITHUB_ACCOUNT_KEY,
    queryFn: () => githubApi<GithubAccountStatus>("/me/github"),
    enabled: open,
  });

  // Repo picker needs a personal token; on legacy server-token installs it
  // 400s and we fall back to a plain owner/name input.
  const repos = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => githubApi<RepoEntry[]>("/me/github/repos"),
    enabled: open && !githubRepo && account?.connected === true,
    retry: false,
  });

  const createRepo = useMutation({
    mutationFn: (body: { name: string; private: boolean }) =>
      githubApi<{ repo: string; pushed: boolean; pushDetail: string }>(
        `/sessions/${sessionId}/github/repo`,
        { method: "POST", body: JSON.stringify({ mode: "create", ...body }) },
      ),
    onSuccess: (data) => {
      refreshSession();
      if (data.pushed) ok(`Created ${data.repo} and pushed the workspace history`);
      else {
        setNotice(null);
        setError(`Created ${data.repo}, but the initial push failed: ${data.pushDetail}`);
      }
    },
    onError: fail,
  });

  const linkRepo = useMutation({
    mutationFn: (repo: string) =>
      githubApi<{ repo: string }>(`/sessions/${sessionId}/github/repo`, {
        method: "POST",
        body: JSON.stringify({ mode: "link", repo }),
      }),
    onSuccess: (data) => {
      refreshSession();
      ok(`Linked ${data.repo} — use PUSH to upload the workspace history`);
    },
    onError: fail,
  });

  const push = useMutation({
    mutationFn: () =>
      githubApi<{ ok: boolean; detail: string }>(`/sessions/${sessionId}/github/push`, {
        method: "POST",
      }),
    onSuccess: () => ok("Pushed to origin"),
    onError: fail,
  });

  const patch = useMutation({
    mutationFn: (body: { autopush?: boolean; unlink?: boolean }) =>
      githubApi<{ repo: string | null; autopush: boolean }>(`/sessions/${sessionId}/github`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      refreshSession();
      if (data.repo === null) ok("Repo unlinked (local history kept)");
      else ok(data.autopush ? "Auto-push enabled" : "Auto-push disabled");
    },
    onError: fail,
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setName(slugify(sessionTitle));
      setLinkTarget("");
      setError(null);
      setNotice(null);
    }
  };

  const busy = createRepo.isPending || linkRepo.isPending;
  const canUseGithub = account ? account.connected || account.serverToken : true;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 font-mono tracking-widest text-[10px] rounded-sm px-3 gap-1.5"
        >
          <Github className="w-3.5 h-3.5" />
          {githubRepo ? (
            <span className="flex items-center gap-1.5">
              GITHUB
              <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_6px_rgba(255,122,24,0.8)]" />
            </span>
          ) : (
            "GITHUB"
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md border-border bg-card rounded-sm">
        <DialogHeader>
          <DialogTitle className="font-mono tracking-widest text-sm uppercase flex items-center gap-2">
            <Github className="w-4 h-4 text-primary" /> Session Repo
          </DialogTitle>
        </DialogHeader>

        {!canUseGithub ? (
          <p className="font-mono text-[11px] text-muted-foreground border border-border rounded-sm px-3 py-2.5 bg-background">
            No GitHub account connected. Open the GitHub settings (bottom-left) and paste a
            personal access token first.
          </p>
        ) : githubRepo ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between border border-border rounded-sm px-3 py-2.5 bg-background">
              <a
                href={`https://github.com/${githubRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-primary hover:underline flex items-center gap-1.5 truncate"
              >
                {githubRepo} <ExternalLink className="w-3 h-3 shrink-0" />
              </a>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 font-mono tracking-widest text-[10px] rounded-sm text-muted-foreground hover:text-destructive"
                onClick={() => patch.mutate({ unlink: true })}
                disabled={patch.isPending}
              >
                UNLINK
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs font-bold tracking-wide">AUTO-PUSH</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  Push to origin after every checkpoint
                </span>
              </div>
              <Switch
                checked={githubAutopush}
                onCheckedChange={(v) => patch.mutate({ autopush: v })}
                disabled={patch.isPending}
              />
            </div>

            <Button
              className="w-full h-9 font-mono tracking-widest text-xs rounded-sm gap-2"
              onClick={() => push.mutate()}
              disabled={push.isPending}
            >
              {push.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <UploadCloud className="w-4 h-4" />
              )}
              {push.isPending ? "PUSHING…" : "PUSH NOW"}
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            <form
              className="space-y-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                const n = name.trim();
                if (n) createRepo.mutate({ name: n, private: isPrivate });
              }}
            >
              <Label className={labelCls}>Create new repo</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="repo-name"
                className={inputCls}
                autoComplete="off"
              />
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  Private
                </span>
                <Switch checked={isPrivate} onCheckedChange={setIsPrivate} disabled={busy} />
              </div>
              <Button
                type="submit"
                disabled={!name.trim() || busy}
                className="w-full h-9 font-mono tracking-widest text-xs rounded-sm"
              >
                {createRepo.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "CREATE & PUSH"
                )}
              </Button>
            </form>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="font-mono text-[10px] text-muted-foreground tracking-widest">OR</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form
              className="space-y-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                const target = linkTarget.trim();
                if (target) linkRepo.mutate(target);
              }}
            >
              <Label className={labelCls}>Link existing repo</Label>
              {repos.data && repos.data.length > 0 ? (
                <select
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                  className="w-full h-9 font-mono text-sm bg-background border border-input rounded-sm px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <option value="">— select a repo —</option>
                  {repos.data.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                      {r.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                  placeholder="owner/repo"
                  className={inputCls}
                  autoComplete="off"
                />
              )}
              <Button
                type="submit"
                variant="outline"
                disabled={!linkTarget.trim() || busy}
                className="w-full h-9 font-mono tracking-widest text-xs rounded-sm"
              >
                {linkRepo.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "LINK"}
              </Button>
            </form>
          </div>
        )}

        {error && (
          <p className="font-mono text-[11px] text-destructive border border-destructive/40 rounded-sm px-3 py-2 bg-destructive/5 break-words">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className="font-mono text-[11px] text-primary border border-primary/40 rounded-sm px-3 py-2 bg-primary/5">
            {notice}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
