import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, Loader2, RotateCcw, FileDiff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatDate } from "@/lib/utils";

export interface Checkpoint {
  hash: string;
  shortHash: string;
  subject: string;
  timestamp: string;
  filesChanged: number;
}

interface CheckpointsPanelProps {
  sessionId: number;
  /** Called after a successful revert so the parent can refresh everything. */
  onReverted: () => void;
}

export default function CheckpointsPanel({ sessionId, onReverted }: CheckpointsPanelProps) {
  const base = import.meta.env.BASE_URL;
  const { data: checkpoints, isLoading, isError, refetch } = useQuery<Checkpoint[]>({
    queryKey: ["checkpoints", sessionId],
    queryFn: async () => {
      const r = await fetch(`${base}api/sessions/${sessionId}/checkpoints`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    retry: 1, // settle fast on server errors instead of spinning through retries
  });

  const [diffFor, setDiffFor] = useState<Checkpoint | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [confirmHash, setConfirmHash] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<string | null>(null);

  const openDiff = async (cp: Checkpoint) => {
    setDiffFor(cp);
    setDiff(null);
    try {
      const r = await fetch(`${base}api/sessions/${sessionId}/checkpoints/${cp.hash}/diff`, {
        credentials: "include",
      });
      const d = await r.json().catch(() => ({}));
      setDiff(r.ok ? d.diff : `Failed to load diff (${d.error ?? r.status})`);
    } catch {
      setDiff("Failed to load diff");
    }
  };

  const armRevert = (cp: Checkpoint) => {
    setConfirmHash(cp.hash);
    setTimeout(() => setConfirmHash((h) => (h === cp.hash ? null : h)), 4000);
  };

  const revert = async (cp: Checkpoint) => {
    setConfirmHash(null);
    setBusyHash(cp.hash);
    try {
      const r = await fetch(`${base}api/sessions/${sessionId}/checkpoints/${cp.hash}/revert`, {
        method: "POST",
        credentials: "include",
      });
      if (r.ok) onReverted();
    } finally {
      setBusyHash(null);
    }
  };

  const diffLineClass = (l: string) =>
    l.startsWith("+") && !l.startsWith("+++")
      ? "text-emerald-400"
      : l.startsWith("-") && !l.startsWith("---")
        ? "text-red-400"
        : l.startsWith("@@")
          ? "text-primary"
          : l.startsWith("commit ") || l.startsWith("diff --git")
            ? "text-foreground font-bold"
            : "text-muted-foreground";

  return (
    <>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="px-4 py-8 text-center border border-dashed border-destructive/40 rounded-sm m-2">
              <p className="text-xs font-mono text-destructive">CHECKPOINTS UNAVAILABLE</p>
              <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">
                The server could not read this session checkpoint history.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-6 px-2 font-mono text-[9px] tracking-widest text-muted-foreground hover:text-primary"
                onClick={() => refetch()}
              >
                RETRY
              </Button>
            </div>
          ) : !checkpoints?.length ? (
            <div className="px-4 py-8 text-center border border-dashed border-border rounded-sm m-2">
              <p className="text-xs font-mono text-muted-foreground">NO CHECKPOINTS YET</p>
              <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">
                One is saved automatically after every agent turn.
              </p>
            </div>
          ) : (
            checkpoints.map((cp, i) => (
              <div
                key={cp.hash}
                className={cn(
                  "px-3 py-2 rounded-sm border border-transparent hover:border-border hover:bg-muted/50 transition-colors group",
                  i === 0 && "border-border bg-muted/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <GitCommitHorizontal className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="font-mono text-[10px] font-bold text-primary">{cp.shortHash}</span>
                  {i === 0 && (
                    <span className="font-mono text-[8px] tracking-widest text-muted-foreground border border-border rounded-sm px-1 py-px">
                      CURRENT
                    </span>
                  )}
                  <span className="font-mono text-[9px] text-muted-foreground ml-auto shrink-0">
                    {cp.filesChanged > 0 ? `${cp.filesChanged} file${cp.filesChanged === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                <p className="font-mono text-[10px] text-foreground/90 truncate mt-1" title={cp.subject}>
                  {cp.subject}
                </p>
                <div className="flex items-center justify-between mt-1">
                  <span className="font-mono text-[9px] text-muted-foreground">{formatDate(cp.timestamp)}</span>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 font-mono text-[8px] tracking-widest text-muted-foreground hover:text-primary"
                      onClick={() => openDiff(cp)}
                    >
                      <FileDiff className="w-3 h-3 mr-0.5" /> DIFF
                    </Button>
                    {i !== 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyHash !== null}
                        className={cn(
                          "h-5 px-1.5 font-mono text-[8px] tracking-widest",
                          confirmHash === cp.hash
                            ? "text-destructive-foreground bg-destructive hover:bg-destructive/90"
                            : "text-muted-foreground hover:text-destructive",
                        )}
                        onClick={() => (confirmHash === cp.hash ? revert(cp) : armRevert(cp))}
                      >
                        {busyHash === cp.hash ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <>
                            <RotateCcw className="w-3 h-3 mr-0.5" />
                            {confirmHash === cp.hash ? "CONFIRM?" : "REVERT"}
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Diff viewer */}
      {diffFor && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={() => setDiffFor(null)}>
          <div
            className="bg-card border border-border rounded-sm w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-10 border-b border-border bg-muted flex items-center justify-between px-3 shrink-0">
              <span className="font-mono text-xs font-bold flex items-center gap-2">
                <GitCommitHorizontal className="w-4 h-4 text-primary" />
                {diffFor.shortHash}
                <span className="text-muted-foreground font-normal truncate max-w-md">{diffFor.subject}</span>
              </span>
              <Button variant="ghost" size="icon" className="w-6 h-6" onClick={() => setDiffFor(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto bg-background">
              {diff === null ? (
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <pre className="p-4 text-[11px] font-mono leading-relaxed min-w-max">
                  {diff.split("\n").map((l, i) => (
                    <div key={i} className={diffLineClass(l)}>
                      {l || " "}
                    </div>
                  ))}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
