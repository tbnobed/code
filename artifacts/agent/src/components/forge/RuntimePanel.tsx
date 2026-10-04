import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useControlRuntime,
  useSaveRuntime,
  getGetRuntimeQueryKey,
  type RuntimeStatus,
  type RuntimeActionAction,
} from "@workspace/api-client-react";
import { Play, Square, RotateCcw, Package, Hammer, Loader2, Plus, Trash2, Save, AlertCircle, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PreviewBrowserError {
  message: string;
  at: number;
}

interface RuntimePanelProps {
  sessionId: number;
  runtime: RuntimeStatus | undefined;
  isLoading: boolean;
  loadError: boolean;
  browserErrors: PreviewBrowserError[];
  onClearBrowserErrors: () => void;
}

const STATE_STYLE: Record<string, string> = {
  running: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10",
  stopped: "text-muted-foreground border-border bg-muted/40",
  error: "text-destructive border-destructive/40 bg-destructive/10",
  installing: "text-primary border-primary/40 bg-primary/10",
  starting: "text-primary border-primary/40 bg-primary/10",
  building: "text-primary border-primary/40 bg-primary/10",
};

const MAX_LOG_CHARS = 20000;

function errMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const d = (e as { data?: { error?: string } }).data;
    if (d?.error) return d.error;
    if ((e as Error).message) return (e as Error).message;
  }
  return "Request failed";
}

export default function RuntimePanel({ sessionId, runtime, isLoading, loadError, browserErrors, onClearBrowserErrors }: RuntimePanelProps) {
  const queryClient = useQueryClient();
  const control = useControlRuntime();
  const save = useSaveRuntime();
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<"logs" | "settings" | "errors">("logs");

  const [command, setCommand] = useState("");
  const [backendCommand, setBackendCommand] = useState("");
  const [backendDirectory, setBackendDirectory] = useState(".");
  const [envUpdates, setEnvUpdates] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const initFor = useRef<number | null>(null);

  useEffect(() => {
    if (runtime && initFor.current !== sessionId) {
      initFor.current = sessionId;
      setCommand(runtime.settings.command ?? "");
      setBackendCommand(runtime.settings.backendCommand ?? "");
      setBackendDirectory(runtime.settings.backendDirectory || ".");
    }
  }, [runtime, sessionId]);

  const logRef = useRef<HTMLPreElement>(null);
  const logs = runtime?.logs ? runtime.logs.slice(-MAX_LOG_CHARS) : "";
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const state = runtime?.state ?? "stopped";
  const busy = state === "installing" || state === "starting" || state === "building";
  const active = state === "running" || busy;

  const act = (action: RuntimeActionAction) => {
    setActionError(null);
    control.mutate(
      { id: sessionId, data: { action } },
      {
        onSuccess: (data) => {
          if (data && typeof data === "object" && "state" in data) queryClient.setQueryData(getGetRuntimeQueryKey(sessionId), data);
          else queryClient.invalidateQueries({ queryKey: getGetRuntimeQueryKey(sessionId) });
        },
        onError: (e) => setActionError(errMessage(e)),
      },
    );
  };

  const addEnv = () => {
    const k = newKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { setSaveMsg("Key must be letters, digits, underscore and not start with a digit."); return; }
    setEnvUpdates((u) => ({ ...u, [k]: newValue }));
    setNewKey(""); setNewValue(""); setSaveMsg(null);
  };

  const handleSave = () => {
    setSaveMsg(null);
    const hasEnv = Object.keys(envUpdates).length > 0;
    save.mutate(
      { id: sessionId, data: { command: command.trim(), backendCommand: backendCommand.trim(), backendDirectory: backendDirectory.trim() || ".", ...(hasEnv ? { environment: envUpdates } : {}) } },
      {
        onSuccess: (data) => {
          setEnvUpdates({});
          if (data && typeof data === "object" && "state" in data) queryClient.setQueryData(getGetRuntimeQueryKey(sessionId), data);
          queryClient.invalidateQueries({ queryKey: getGetRuntimeQueryKey(sessionId) });
          setSaveMsg("Saved. Runtime stopped; press Run to apply.");
        },
        onError: (e) => setSaveMsg(errMessage(e)),
      },
    );
  };

  const storedKeys = runtime?.environmentKeys ?? [];
  const pendingRemovals = Object.entries(envUpdates).filter(([, v]) => v === "").map(([k]) => k);
  const pendingSets = Object.entries(envUpdates).filter(([, v]) => v !== "").map(([k]) => k);

  const btn = "h-7 font-mono tracking-widest text-[10px] rounded-sm px-2.5 gap-1.5";

  return (
    <section aria-label="Managed runtime" className="border-b border-border bg-card flex flex-col max-h-[55%] min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border">
        <span
          role="status"
          aria-live="polite"
          className={cn("font-mono text-[10px] font-bold tracking-widest uppercase border rounded-sm px-2 py-0.5 flex items-center gap-1.5", STATE_STYLE[state])}
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {isLoading ? "loading" : loadError ? "unavailable" : state}
        </span>
        {runtime?.framework && <span className="font-mono text-[10px] text-muted-foreground">{runtime.framework}</span>}
        <div className="flex items-center gap-1 ml-auto flex-wrap">
          <Button size="sm" className={btn} disabled={!runtime || active || control.isPending} onClick={() => act("run")} aria-label="Run app">
            <Play className="w-3 h-3" /> RUN
          </Button>
          <Button size="sm" variant="outline" className={btn} disabled={!runtime || !active || control.isPending} onClick={() => act("stop")} aria-label="Stop app">
            <Square className="w-3 h-3" /> STOP
          </Button>
          <Button size="sm" variant="outline" className={btn} disabled={!runtime || control.isPending} onClick={() => act("restart")} aria-label="Restart app">
            <RotateCcw className="w-3 h-3" /> RESTART
          </Button>
          <Button size="sm" variant="ghost" className={btn} disabled={!runtime || busy || control.isPending} onClick={() => act("install")} aria-label="Install dependencies">
            <Package className="w-3 h-3" /> INSTALL
          </Button>
          <Button size="sm" variant="ghost" className={btn} disabled={!runtime || busy || control.isPending} onClick={() => act("build")} aria-label="Run production build">
            <Hammer className="w-3 h-3" /> BUILD
          </Button>
        </div>
      </div>

      {(actionError || runtime?.error) && (
        <div role="alert" className="mx-3 mt-2 flex gap-2 items-start text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-2 py-1.5 whitespace-pre-wrap break-words max-h-24 overflow-auto">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{actionError ?? runtime?.error}</span>
        </div>
      )}

      <div role="tablist" aria-label="Runtime views" className="flex gap-1 px-3 pt-2">
        {([["logs", "LOGS"], ["errors", `BROWSER_ERRORS${browserErrors.length ? ` (${browserErrors.length})` : ""}`], ["settings", "SETTINGS"]] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("font-mono text-[10px] font-bold tracking-widest px-2 py-1 rounded-sm border", tab === id ? "border-primary text-primary bg-primary/10" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {tab === "logs" && (
          <pre ref={logRef} aria-label="Runtime logs" className="h-48 overflow-auto bg-background border border-border rounded-sm p-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
            {logs || (loadError ? "Runtime status could not be loaded." : "No output yet. Press Run to start the app.")}
          </pre>
        )}

        {tab === "errors" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] text-muted-foreground">Errors reported by the preview page (latest 30, this tab only).</p>
              <Button size="sm" variant="ghost" className={btn} disabled={!browserErrors.length} onClick={onClearBrowserErrors}>CLEAR</Button>
            </div>
            {browserErrors.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground border border-dashed border-border rounded-sm p-4 text-center">No browser errors captured.</p>
            ) : (
              <ul className="space-y-1">
                {browserErrors.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="font-mono text-[11px] text-destructive bg-destructive/5 border border-destructive/20 rounded-sm px-2 py-1 whitespace-pre-wrap break-words">
                    <span className="text-muted-foreground mr-2">{new Date(e.at).toLocaleTimeString()}</span>{e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "settings" && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
            <div className="space-y-1">
              <label htmlFor="rt-cmd" className="font-mono text-[10px] font-bold tracking-widest text-muted-foreground">FRONTEND COMMAND</label>
              <Input id="rt-cmd" value={command} maxLength={2000} onChange={(e) => setCommand(e.target.value)} placeholder="Empty = auto-detect Next.js / Vite / static" className="h-8 font-mono text-xs rounded-sm" />
              <p className="text-[10px] font-mono text-muted-foreground">A custom command must listen on the port in the PORT environment variable.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
              <div className="space-y-1">
                <label htmlFor="rt-be" className="font-mono text-[10px] font-bold tracking-widest text-muted-foreground">BACKEND COMMAND (OPTIONAL)</label>
                <Input id="rt-be" value={backendCommand} maxLength={2000} onChange={(e) => setBackendCommand(e.target.value)} placeholder="e.g. node server.js" className="h-8 font-mono text-xs rounded-sm" />
              </div>
              <div className="space-y-1">
                <label htmlFor="rt-dir" className="font-mono text-[10px] font-bold tracking-widest text-muted-foreground">BACKEND DIRECTORY</label>
                <Input id="rt-dir" value={backendDirectory} maxLength={500} onChange={(e) => setBackendDirectory(e.target.value)} placeholder="." className="h-8 font-mono text-xs rounded-sm" />
              </div>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">The backend is exposed under /api inside the preview. Directory is relative to the workspace.</p>

            <fieldset className="space-y-2 border border-border rounded-sm p-2">
              <legend className="px-1 font-mono text-[10px] font-bold tracking-widest text-muted-foreground flex items-center gap-1"><KeyRound className="w-3 h-3" /> PROJECT ENVIRONMENT</legend>
              <p className="text-[10px] font-mono text-muted-foreground">Values are write-only and never shown again. Create a dedicated PostgreSQL database in the Database tab, or set DATABASE_URL for an external database. Restart the runtime after changing its environment.</p>
              {storedKeys.length > 0 && (
                <ul className="flex flex-wrap gap-1" aria-label="Stored keys">
                  {storedKeys.map((k) => {
                    const removing = pendingRemovals.includes(k);
                    return (
                      <li key={k} className={cn("flex items-center gap-1 font-mono text-[10px] border rounded-sm pl-2 pr-0.5 py-0.5", removing ? "border-destructive/40 text-destructive line-through" : "border-border")}>
                        {k} <span className="text-muted-foreground no-underline">= ••••</span>
                        <button type="button" aria-label={removing ? `Keep ${k}` : `Remove ${k}`} className="p-0.5 hover:text-destructive"
                          onClick={() => setEnvUpdates((u) => { const n = { ...u }; if (removing) delete n[k]; else n[k] = ""; return n; })}>
                          {removing ? <RotateCcw className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {pendingSets.length > 0 && (
                <p className="text-[10px] font-mono text-primary">Pending: {pendingSets.join(", ")}
                  <button type="button" className="ml-2 underline" onClick={() => setEnvUpdates((u) => Object.fromEntries(Object.entries(u).filter(([, v]) => v === "")))}>discard</button>
                </p>
              )}
              <div className="flex gap-1">
                <Input aria-label="Environment key" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="DATABASE_URL" className="h-8 font-mono text-xs rounded-sm w-2/5" autoComplete="off" />
                <Input aria-label="Environment value" type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value" className="h-8 font-mono text-xs rounded-sm flex-1" autoComplete="new-password" />
                <Button type="button" size="sm" variant="outline" className={btn} disabled={!newKey.trim() || !newValue} onClick={addEnv}><Plus className="w-3 h-3" /> ADD</Button>
              </div>
            </fieldset>

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" className={btn} disabled={save.isPending || !runtime}>
                {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} SAVE SETTINGS
              </Button>
              <span className="text-[10px] font-mono text-muted-foreground" aria-live="polite">{saveMsg ?? "Saving stops the runtime."}</span>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
