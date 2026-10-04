import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Loader2, AlertCircle, RefreshCw, Play, Trash2, Table2, Plus, AlertTriangle, X, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface DbStatus {
  provisioned: boolean;
  name?: string;
  tables?: { schema: string; name: string }[];
  error?: string;
}

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  command: string;
  truncated: boolean;
}

const btn = "h-7 font-mono tracking-widest text-[10px] rounded-sm px-2.5 gap-1.5";
const label = "font-mono text-[10px] font-bold tracking-widest text-muted-foreground";

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

// Strip comments and leading whitespace so the first keyword is real.
function firstKeyword(sql: string): string {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .replace(/^\(+/, "");
  return (stripped.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
}

const DESTRUCTIVE_RE = /\b(DROP|TRUNCATE|DELETE|ALTER|REVOKE|GRANT)\b/i;

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (j && typeof j.error === "string") return j.error;
  } catch { /* not JSON */ }
  return `HTTP ${res.status}`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function DatabasePanel({ sessionId }: { sessionId: number }) {
  const base = `${import.meta.env.BASE_URL}api/sessions/${sessionId}/database`;
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [pendingSql, setPendingSql] = useState<string | null>(null);

  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const sqlRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(base, { credentials: "include" });
      if (!res.ok) throw new Error(await readError(res));
      setStatus(await res.json());
    } catch (e) {
      setLoadError((e as Error).message || "Failed to load database status");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  const provision = async () => {
    setProvisioning(true); setActionError(null);
    try {
      const res = await fetch(base, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(await readError(res));
      setStatus(await res.json());
      setNotice("Database created. DATABASE_URL is injected into the app environment; restart the runtime to use it.");
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setProvisioning(false);
    }
  };

  const destroy = async () => {
    setDeleting(true); setActionError(null);
    try {
      const res = await fetch(base, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = await res.json().catch(() => null);
      setStatus(j && typeof j === "object" && "provisioned" in j ? j : { provisioned: false });
      setShowDelete(false); setDeleteText(""); setResult(null); setQueryError(null);
      setNotice("Database deleted. The runtime was stopped; DATABASE_URL is no longer provided.");
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const execute = async (text: string) => {
    setPendingSql(null);
    setRunning(true); setQueryError(null);
    try {
      const res = await fetch(`${base}/query`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: text }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setResult(await res.json());
      if (firstKeyword(text) !== "SELECT") load(true);
    } catch (e) {
      setResult(null);
      setQueryError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const submit = () => {
    const text = sql.trim();
    if (!text || running) return;
    if (firstKeyword(text) === "SELECT") execute(text);
    else setPendingSql(text);
  };

  const pickTable = (schema: string, name: string) => {
    setSql(`SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(name)} LIMIT 100;`);
    setPendingSql(null);
    requestAnimationFrame(() => sqlRef.current?.focus());
  };

  if (loading) {
    return (
      <div className="flex-1 p-3 space-y-2" aria-busy="true">
        {[70, 45, 85, 55].map((w, i) => (
          <div key={i} className="h-5 bg-muted/60 rounded-sm animate-pulse" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }

  if (loadError || !status) {
    return (
      <div className="flex-1 p-4 flex flex-col items-center justify-center gap-3 text-center">
        <AlertCircle className="w-6 h-6 text-destructive" />
        <p className="font-mono text-xs text-destructive break-words">{loadError ?? "Database status unavailable"}</p>
        <Button size="sm" variant="outline" className={btn} onClick={() => load()}><RefreshCw className="w-3 h-3" /> RETRY</Button>
      </div>
    );
  }

  const tables = status.tables ?? [];
  const deleteMatches = !!status.name && deleteText === status.name;
  const pendingDestructive = pendingSql ? DESTRUCTIVE_RE.test(pendingSql) : false;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] tracking-widest text-muted-foreground truncate">
          {status.provisioned ? `POSTGRESQL // ${status.name ?? "unnamed"}` : "NO DATABASE"}
        </span>
        <Button variant="ghost" size="icon" className="w-6 h-6 shrink-0" title="Refresh schema" aria-label="Refresh schema" disabled={refreshing} onClick={() => load(true)}>
          <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {(actionError || status.error) && (
          <div role="alert" className="flex gap-2 items-start text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-2 py-1.5 whitespace-pre-wrap break-words">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="flex-1">{actionError ?? status.error}</span>
          </div>
        )}
        {notice && (
          <div role="status" className="flex gap-2 items-start text-[11px] font-mono text-primary bg-primary/10 border border-primary/30 rounded-sm px-2 py-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="flex-1">{notice}</span>
            <button aria-label="Dismiss" onClick={() => setNotice(null)}><X className="w-3 h-3" /></button>
          </div>
        )}

        {!status.provisioned ? (
          <div className="border border-dashed border-border rounded-sm p-5 flex flex-col items-center text-center gap-3">
            <div className="w-11 h-11 rounded-sm bg-card border border-border flex items-center justify-center text-primary">
              <Database className="w-5 h-5" />
            </div>
            <p className="font-mono text-xs font-bold tracking-widest">NO PROJECT DATABASE</p>
            <p className="font-mono text-[10px] text-muted-foreground leading-relaxed max-w-[240px]">
              Provision a PostgreSQL database for this project. DATABASE_URL is injected into the app environment automatically; credentials are never shown. Restart the runtime after creating it.
            </p>
            <Button size="sm" className={btn} disabled={provisioning} onClick={provision}>
              {provisioning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              {provisioning ? "PROVISIONING" : "CREATE DATABASE"}
            </Button>
          </div>
        ) : (
          <>
            <section aria-label="Tables" className="space-y-1">
              <p className={label}>TABLES ({tables.length})</p>
              {tables.length === 0 ? (
                <p className="font-mono text-[10px] text-muted-foreground border border-dashed border-border rounded-sm p-3 text-center">
                  No tables yet. Create one with SQL below or let the app run its migrations.
                </p>
              ) : (
                <ul className="border border-border rounded-sm divide-y divide-border max-h-44 overflow-auto">
                  {tables.map((t) => (
                    <li key={`${t.schema}.${t.name}`}>
                      <button
                        onClick={() => pickTable(t.schema, t.name)}
                        title={`Fill a SELECT for ${t.schema}.${t.name}`}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[11px] hover:bg-muted/60 transition-colors"
                      >
                        <Table2 className="w-3 h-3 text-primary shrink-0" />
                        <span className="text-muted-foreground">{t.schema}.</span>
                        <span className="truncate">{t.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="SQL query" className="space-y-1.5">
              <label htmlFor="db-sql" className={label}>SQL</label>
              <textarea
                id="db-sql"
                ref={sqlRef}
                value={sql}
                onChange={(e) => { setSql(e.target.value); setPendingSql(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
                placeholder="SELECT now();"
                spellCheck={false}
                rows={5}
                className="w-full bg-background border border-border rounded-sm p-2 font-mono text-[11px] leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" className={btn} disabled={running || !sql.trim()} onClick={submit}>
                  {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} RUN
                </Button>
                <span className="font-mono text-[9px] text-muted-foreground">Single statement. Ctrl/Cmd+Enter.</span>
              </div>

              {pendingSql && (
                <div role="alertdialog" aria-label="Confirm query" className={cn("rounded-sm border p-2 space-y-2", pendingDestructive ? "border-destructive/50 bg-destructive/10" : "border-primary/40 bg-primary/10")}>
                  <p className={cn("flex gap-1.5 items-start font-mono text-[10px]", pendingDestructive ? "text-destructive" : "text-primary")}>
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {pendingDestructive
                      ? "This statement can permanently destroy data or schema. There is no undo."
                      : `${firstKeyword(pendingSql) || "This"} statement may modify the database. Run it?`}
                  </p>
                  <div className="flex gap-1">
                    <Button size="sm" variant={pendingDestructive ? "destructive" : "default"} className={btn} onClick={() => execute(pendingSql)}>RUN ANYWAY</Button>
                    <Button size="sm" variant="ghost" className={btn} onClick={() => setPendingSql(null)}>CANCEL</Button>
                  </div>
                </div>
              )}
            </section>

            {queryError && (
              <div role="alert" className="flex gap-2 items-start text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-2 py-1.5 whitespace-pre-wrap break-words">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{queryError}</span>
              </div>
            )}

            {result && (
              <section aria-label="Query result" className="space-y-1">
                <p className="font-mono text-[10px] text-muted-foreground">
                  <span className="text-primary font-bold">{result.command || "OK"}</span> // {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
                  {result.truncated && <span className="text-destructive"> // truncated</span>}
                </p>
                {result.columns.length > 0 ? (
                  <div className="border border-border rounded-sm overflow-auto max-h-72">
                    <table className="font-mono text-[11px] border-collapse w-max min-w-full">
                      <thead className="sticky top-0 bg-muted">
                        <tr>{result.columns.map((c, i) => <th key={i} className="text-left px-2 py-1 border-b border-border font-bold whitespace-nowrap">{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {result.rows.length === 0 ? (
                          <tr><td colSpan={result.columns.length} className="px-2 py-3 text-center text-muted-foreground">No rows</td></tr>
                        ) : result.rows.map((r, ri) => (
                          <tr key={ri} className="even:bg-muted/30">
                            {r.map((v, ci) => (
                              <td key={ci} title={formatCell(v)} className={cn("px-2 py-1 border-b border-border/60 whitespace-nowrap max-w-[240px] truncate", (v === null || v === undefined) && "text-muted-foreground italic")}>{formatCell(v)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="font-mono text-[10px] text-muted-foreground border border-dashed border-border rounded-sm p-3 text-center">Statement executed. No result set.</p>
                )}
              </section>
            )}

            <section aria-label="Danger zone" className="border border-destructive/30 rounded-sm p-2 space-y-2">
              <p className="font-mono text-[10px] font-bold tracking-widest text-destructive">DANGER ZONE</p>
              {!showDelete ? (
                <Button size="sm" variant="outline" className={cn(btn, "text-destructive border-destructive/40")} onClick={() => setShowDelete(true)}>
                  <Trash2 className="w-3 h-3" /> DELETE DATABASE
                </Button>
              ) : (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (deleteMatches) destroy(); }}>
                  <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
                    Permanently deletes all data. The runtime will be stopped. Type <span className="text-foreground font-bold break-all">{status.name}</span> to confirm.
                  </p>
                  <Input aria-label="Database name confirmation" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoComplete="off" className="h-8 font-mono text-xs rounded-sm" />
                  <div className="flex gap-1">
                    <Button type="submit" size="sm" variant="destructive" className={btn} disabled={!deleteMatches || deleting}>
                      {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} DELETE FOREVER
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className={btn} onClick={() => { setShowDelete(false); setDeleteText(""); }}>CANCEL</Button>
                  </div>
                </form>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
