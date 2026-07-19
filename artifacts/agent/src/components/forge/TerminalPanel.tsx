import { useState, useRef, useEffect } from "react";
import { Loader2, Square, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Line = { kind: "cmd" | "stdout" | "stderr" | "info"; text: string };

interface TerminalPanelProps {
  sessionId: number;
  /** Called after each command finishes — commands can change workspace files. */
  onWorkspaceChanged: () => void;
}

export default function TerminalPanel({ sessionId, onWorkspaceChanged }: TerminalPanelProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    const command = cmd.trim();
    if (!command || running) return;
    setCmd("");
    setLines((prev) => [...prev, { kind: "cmd", text: `$ ${command}` }]);
    setRunning(true);
    abortRef.current = new AbortController();
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}api/sessions/${sessionId}/exec`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal: abortRef.current.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "stdout" || ev.type === "stderr") {
              setLines((prev) => [...prev, { kind: ev.type, text: ev.data }]);
            } else if (ev.type === "exit") {
              setLines((prev) => [...prev, { kind: "info", text: `[exit ${ev.code ?? "?"}]` }]);
            }
          } catch {
            // skip malformed event
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setLines((prev) => [...prev, { kind: "info", text: "[killed]" }]);
      } else {
        setLines((prev) => [...prev, { kind: "stderr", text: String(err instanceof Error ? err.message : err) }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onWorkspaceChanged();
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
        {lines.length === 0 && (
          <p className="text-muted-foreground/60 p-2">
            Shell in this session's workspace. Commands run on the server; output streams here.
          </p>
        )}
        {lines.map((l, i) => (
          <span
            key={i}
            className={cn(
              "whitespace-pre-wrap break-all",
              l.kind === "cmd" && "block text-primary font-bold mt-2 first:mt-0",
              l.kind === "stderr" && "text-red-400",
              l.kind === "stdout" && "text-foreground/85",
              l.kind === "info" && "block text-muted-foreground",
            )}
          >
            {l.text}
          </span>
        ))}
        {running && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary mt-1" />}
      </div>
      <form
        className="border-t border-border p-2 flex items-center gap-1.5 shrink-0 bg-card"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <ChevronRight className="w-4 h-4 text-primary shrink-0" />
        <input
          ref={inputRef}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder={running ? "running..." : "command"}
          disabled={running}
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50"
        />
        {running ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-6 px-2 font-mono text-[8px] tracking-widest rounded-sm"
            onClick={() => abortRef.current?.abort()}
          >
            <Square className="w-2.5 h-2.5 mr-1 fill-current" /> KILL
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={!cmd.trim()}
            className="h-6 px-2 font-mono text-[8px] tracking-widest rounded-sm"
          >
            RUN
          </Button>
        )}
      </form>
    </div>
  );
}
