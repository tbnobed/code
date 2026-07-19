import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Github, Loader2 } from "lucide-react";
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

const inputCls =
  "font-mono text-sm bg-background border-input focus-visible:ring-primary rounded-sm h-9 transition-colors";

export type GithubAccountStatus = {
  connected: boolean;
  login: string | null;
  /** True when the server still has a global GITHUB_TOKEN fallback configured. */
  serverToken: boolean;
};

export async function githubApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`);
  }
  return body as T;
}

export const GITHUB_ACCOUNT_KEY = ["github-account"] as const;

/**
 * Account-level GitHub connection: paste a PAT once, sessions then create/link
 * repos with it. The token is stored encrypted server-side and never returned.
 */
export default function GithubSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: GITHUB_ACCOUNT_KEY,
    queryFn: () => githubApi<GithubAccountStatus>("/me/github"),
    enabled: open,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: GITHUB_ACCOUNT_KEY });

  const connect = useMutation({
    mutationFn: (t: string) =>
      githubApi<{ connected: boolean; login: string }>("/me/github", {
        method: "PUT",
        body: JSON.stringify({ token: t }),
      }),
    onSuccess: (data) => {
      setToken("");
      setError(null);
      setNotice(`Connected as @${data.login}`);
      refresh();
    },
    onError: (err: Error) => {
      setNotice(null);
      setError(err.message);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => githubApi<{ connected: boolean }>("/me/github", { method: "DELETE" }),
    onSuccess: () => {
      setError(null);
      setNotice("Disconnected");
      refresh();
    },
    onError: (err: Error) => {
      setNotice(null);
      setError(err.message);
    },
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setToken("");
      setError(null);
      setNotice(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="w-8 h-8 text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent shrink-0"
          title="GitHub Account"
        >
          <Github className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md border-border bg-card rounded-sm">
        <DialogHeader>
          <DialogTitle className="font-mono tracking-widest text-sm uppercase flex items-center gap-2">
            <Github className="w-4 h-4 text-primary" /> GitHub Account
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-6 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : status?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between border border-border rounded-sm px-3 py-2.5 bg-background">
              <span className="font-mono text-sm">
                Connected as{" "}
                <a
                  href={`https://github.com/${status.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  @{status.login}
                </a>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 font-mono tracking-widest text-[10px] rounded-sm"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                {disconnect.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "DISCONNECT"}
              </Button>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
              Sessions can now create or link repos on this account. Commits are attributed to
              your GitHub noreply address.
            </p>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const t = token.trim();
              if (t) connect.mutate(t);
            }}
          >
            {status?.serverToken && (
              <p className="font-mono text-[10px] text-muted-foreground border border-border rounded-sm px-3 py-2 bg-background">
                A server-wide token is active as fallback. Connecting your own account makes
                repos and commits belong to you instead.
              </p>
            )}
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Personal access token
              </Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… or github_pat_…"
                className={inputCls}
                autoComplete="off"
              />
              <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
                Classic token with <span className="text-foreground">repo</span> scope, or a
                fine-grained token with Contents (read/write) + Administration (read/write) for
                repo creation. Stored encrypted; never shown again.
              </p>
            </div>
            <Button
              type="submit"
              disabled={!token.trim() || connect.isPending}
              className="w-full h-9 font-mono tracking-widest text-xs rounded-sm"
            >
              {connect.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "CONNECT"}
            </Button>
          </form>
        )}

        {error && (
          <p className="font-mono text-[11px] text-destructive border border-destructive/40 rounded-sm px-3 py-2 bg-destructive/5">
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
