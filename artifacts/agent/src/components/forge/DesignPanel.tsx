import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, AlertCircle, Save, RotateCcw, MessageSquareText, Undo2, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const DESIGN_KEYS = [
  "color", "background-color", "font-size", "font-weight", "line-height",
  "padding", "margin", "border-radius", "width", "max-width", "text-align",
] as const;
type DesignKey = (typeof DESIGN_KEYS)[number];

interface Selection { selector: string; text: string; styles: Record<string, string> }

interface DesignPanelProps {
  sessionId: number;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  previewUrl: string | null;
  onSaved: () => void;
  onAskAgent: (prompt: string) => void;
}

const GROUPS: { label: string; keys: DesignKey[] }[] = [
  { label: "TYPE", keys: ["color", "font-size", "font-weight", "line-height", "text-align"] },
  { label: "SURFACE", keys: ["background-color", "border-radius"] },
  { label: "BOX", keys: ["padding", "margin", "width", "max-width"] },
];

function isColorKey(k: string) { return k === "color" || k === "background-color"; }

function toHex(v: string): string | null {
  const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + v.slice(1).split("").map((c) => c + c).join("");
  return null;
}

function pick(styles: Record<string, string> | undefined): Record<DesignKey, string> {
  const o = {} as Record<DesignKey, string>;
  for (const k of DESIGN_KEYS) o[k] = String(styles?.[k] ?? "");
  return o;
}

async function readError(res: Response): Promise<string> {
  try { const j = await res.json(); if (j?.error) return String(j.error); } catch { /* ignore */ }
  return `HTTP ${res.status}`;
}

export default function DesignPanel({ sessionId, iframeRef, previewUrl, onSaved, onAskAgent }: DesignPanelProps) {
  const base = `${import.meta.env.BASE_URL}api/sessions/${sessionId}/design`;
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [savedCss, setSavedCss] = useState("");
  const [rules, setRules] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<Record<DesignKey, string>>(pick(undefined));
  const [request, setRequest] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(base, { credentials: "include" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { supported: boolean; css: string; rules?: Record<string, Record<string, string>>; error?: string };
      setRules(j.rules && typeof j.rules === "object" ? j.rules : {});
      setSupported(!!j.supported);
      setSavedCss(j.css ?? "");
      if (j.error) setError(j.error);
    } catch (e) {
      setError((e as Error).message || "Could not load design overrides");
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  const post = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, [iframeRef]);

  // Design mode handshake: on mount, on each iframe load, off on cleanup.
  useEffect(() => {
    const iframe = iframeRef.current;
    const enable = () => post({ type: "forge-design-mode", enabled: true });
    enable();
    iframe?.addEventListener("load", enable);
    return () => {
      iframe?.removeEventListener("load", enable);
      post({ type: "forge-design-css", css: "" });
      post({ type: "forge-design-mode", enabled: false });
    };
  }, [iframeRef, post, previewUrl]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || event.source !== win) return;
      const d = event.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || d.type !== "forge-design-selection" || typeof d.selector !== "string") return;
      const styles = (d.styles && typeof d.styles === "object" ? d.styles : {}) as Record<string, string>;
      setSelection({ selector: d.selector, text: String(d.text ?? "").slice(0, 200), styles });
      setDraft(pick(styles));
      setNotice(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef]);

  const changed = useMemo(() => {
    if (!selection) return {} as Record<string, string>;
    const orig = pick(selection.styles);
    const out: Record<string, string> = {};
    for (const k of DESIGN_KEYS) if (draft[k].trim() && draft[k].trim() !== orig[k].trim()) out[k] = draft[k].trim();
    return out;
  }, [draft, selection]);
  const changeCount = Object.keys(changed).length;

  // Live preview of the unsaved draft for the single selected selector.
  useEffect(() => {
    if (!selection) return;
    const body = Object.entries(changed).map(([k, v]) => `  ${k}: ${v.replace(/[;{}]/g, "")} !important;`).join("\n");
    post({ type: "forge-design-css", css: body ? `${selection.selector} {\n${body}\n}` : "" });
  }, [changed, selection, post]);

  const save = async () => {
    if (!selection || !changeCount) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const res = await fetch(base, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selector: selection.selector, styles: changed }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { css: string };
      setSavedCss(j.css ?? "");
      setSelection((s) => (s ? { ...s, styles: { ...s.styles, ...changed } } : s));
      post({ type: "forge-design-css", css: "" });
      void load();
      setNotice(`Saved ${changeCount} propert${changeCount === 1 ? "y" : "ies"} with a checkpoint.`);
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const reset = async () => {
    if (!window.confirm("Remove ALL saved visual overrides for this project? A checkpoint is created first.")) return;
    setBusy("reset"); setError(null); setNotice(null);
    try {
      const res = await fetch(base, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { css: string };
      setSavedCss(j.css ?? "");
      setSelection(null);
      setRules({});
      post({ type: "forge-design-css", css: "" });
      setNotice("All visual overrides removed.");
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const savedForSel = selection ? rules[selection.selector] ?? {} : {};
  const removeSaved = async (k: string) => {
    if (!selection) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const res = await fetch(base, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selector: selection.selector, styles: { [k]: "" } }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { css: string };
      setSavedCss(j.css ?? "");
      await load();
      setNotice(`Removed saved ${k}.`);
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const askAgent = () => {
    if (!selection) return;
    const lines = [
      `Change this element in the app's source code:`,
      `- Selector: ${selection.selector}`,
      selection.text ? `- Text: "${selection.text}"` : "",
      changeCount ? `- Desired styles: ${Object.entries(changed).map(([k, v]) => `${k}: ${v}`).join("; ")}` : "",
      `- Request: ${request.trim() || "(describe the change)"}`,
      `Edit the real component/stylesheet rather than adding overrides.`,
    ].filter(Boolean);
    onAskAgent(lines.join("\n"));
  };

  const ruleCount = Object.keys(rules).length || (savedCss.match(/\{/g) ?? []).length;
  const btn = "h-7 font-mono tracking-widest text-[10px] rounded-sm px-2.5 gap-1.5";

  return (
    <section aria-label="Visual style inspector" className="border-b border-border bg-card flex flex-col max-h-[60%] min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border">
        <span className={cn("font-mono text-[10px] font-bold tracking-widest uppercase border rounded-sm px-2 py-0.5 flex items-center gap-1.5",
          supported ? "text-primary border-primary/40 bg-primary/10" : "text-muted-foreground border-border bg-muted/40")}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crosshair className="w-3 h-3" />}
          {loading ? "loading" : supported ? "design mode" : "unsupported"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{ruleCount} saved rule{ruleCount === 1 ? "" : "s"}</span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className={btn} onClick={load} disabled={loading}>REFRESH</Button>
          <Button size="sm" variant="outline" className={cn(btn, "hover:text-destructive hover:border-destructive/50")} disabled={!supported || !ruleCount || busy !== null} onClick={reset}>
            {busy === "reset" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} RESET ALL
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mx-3 mt-2 flex gap-2 items-start text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-2 py-1.5 break-words">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      {notice && <p aria-live="polite" className="mx-3 mt-2 font-mono text-[10px] text-primary">{notice}</p>}

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {!loading && supported === false ? (
          <p className="font-mono text-xs text-muted-foreground border border-dashed border-border rounded-sm p-4">
            Visual overrides are not available for this project{error ? "" : " (no supported stylesheet entry found)"}. You can still describe changes to the agent in chat.
          </p>
        ) : !previewUrl ? (
          <p className="font-mono text-xs text-muted-foreground border border-dashed border-border rounded-sm p-4 text-center">Start the runtime to inspect elements.</p>
        ) : !selection ? (
          <div className="border border-dashed border-border rounded-sm p-5 text-center space-y-1">
            <Crosshair className="w-5 h-5 mx-auto text-primary" />
            <p className="font-mono text-xs font-bold tracking-widest">CLICK AN ELEMENT IN THE PREVIEW</p>
            <p className="font-mono text-[10px] text-muted-foreground">Its computed styles appear here for editing.</p>
          </div>
        ) : (
          <>
            <div className="border border-border rounded-sm bg-background p-2 space-y-1">
              <code className="block font-mono text-[11px] text-primary break-all">{selection.selector}</code>
              {selection.text && <p className="font-mono text-[10px] text-muted-foreground truncate">"{selection.text}"</p>}
            </div>

            {Object.keys(savedForSel).length > 0 && (
              <div className="border border-primary/30 bg-primary/5 rounded-sm p-2 space-y-1">
                <p className="font-mono text-[9px] font-bold tracking-[0.2em] text-primary">SAVED OVERRIDES ON THIS SELECTOR</p>
                <ul className="flex flex-wrap gap-1">
                  {Object.entries(savedForSel).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1 font-mono text-[10px] border border-border bg-background rounded-sm pl-2 pr-0.5 py-0.5">
                      {k}: {v}
                      <button type="button" aria-label={`Remove saved ${k}`} disabled={busy !== null} onClick={() => removeSaved(k)} className="p-0.5 hover:text-destructive disabled:opacity-40">
                        <X className="w-3 h-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {GROUPS.map((g) => (
              <fieldset key={g.label} className="space-y-1.5">
                <legend className="font-mono text-[9px] font-bold tracking-[0.2em] text-muted-foreground mb-1">{g.label}</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5">
                  {g.keys.map((k) => {
                    const dirty = k in changed;
                    const hex = isColorKey(k) ? toHex(draft[k]) : null;
                    return (
                      <label key={k} className="flex items-center gap-2">
                        <span className={cn("font-mono text-[10px] w-24 shrink-0 truncate", dirty ? "text-primary font-bold" : "text-muted-foreground")}>{k}</span>
                        {isColorKey(k) && (
                          <input type="color" aria-label={`${k} picker`} value={hex ?? "#000000"}
                            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                            className="w-6 h-6 shrink-0 rounded-sm border border-border bg-transparent cursor-pointer p-0" />
                        )}
                        {k === "text-align" ? (
                          <select value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                            className="h-7 flex-1 min-w-0 rounded-sm border border-input bg-background font-mono text-[11px] px-1">
                            {["", "left", "center", "right", "justify", "start", "end"].map((o) => <option key={o} value={o}>{o || "(unset)"}</option>)}
                          </select>
                        ) : (
                          <Input value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                            className={cn("h-7 flex-1 min-w-0 font-mono text-[11px] rounded-sm", dirty && "border-primary")} spellCheck={false} />
                        )}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" className={btn} disabled={!changeCount || busy !== null || !supported} onClick={save}>
                {busy === "save" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} SAVE{changeCount ? ` (${changeCount})` : ""}
              </Button>
              <Button size="sm" variant="ghost" className={btn} disabled={!changeCount} onClick={() => setDraft(pick(selection.styles))}>
                <Undo2 className="w-3 h-3" /> DISCARD
              </Button>
              <span className="font-mono text-[10px] text-muted-foreground">{changeCount ? "Previewing live. Only edited properties are saved." : "No changes."}</span>
            </div>

            <div className="border-t border-border pt-3 space-y-1.5">
              <label htmlFor="design-ask" className="font-mono text-[10px] font-bold tracking-widest text-muted-foreground">ASK THE AGENT (TEXT, LAYOUT, STRUCTURE)</label>
              <div className="flex gap-1">
                <Input id="design-ask" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. change the heading copy, add an icon" className="h-8 font-mono text-xs rounded-sm flex-1" />
                <Button size="sm" variant="outline" className={btn} onClick={askAgent}><MessageSquareText className="w-3 h-3" /> TO CHAT</Button>
              </div>
            </div>
          </>
        )}

        <p className="flex gap-1.5 font-mono text-[10px] text-muted-foreground leading-relaxed">
          <Info className="w-3 h-3 shrink-0 mt-0.5" />
          Saved styles are written to a real CSS override file included in the app build. Selectors are generated from page structure, so later structural edits can make a rule stop matching.
        </p>
      </div>
    </section>
  );
}
