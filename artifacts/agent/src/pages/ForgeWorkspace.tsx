import { useState, useRef, useEffect, useCallback } from "react";
import { useGetSession, useListWorkspaceFiles, useReadWorkspaceFile, useGetCapabilities } from "@workspace/api-client-react";
import { Terminal, Send, Cpu, FileCode2, HardDrive, Loader2, AlertCircle, FileText, ChevronRight, CornerDownRight, Globe, RefreshCw, ExternalLink, Download, Paperclip, Upload, X, Pencil, Save, Square, RotateCcw, GitCommitHorizontal, SquareTerminal, Brain, ShieldCheck } from "lucide-react";
import { useChatStream } from "@/hooks/use-chat-stream";
import CheckpointsPanel from "@/components/forge/CheckpointsPanel";
import GithubPanel from "@/components/GithubPanel";
import TerminalPanel from "@/components/forge/TerminalPanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getGetSessionQueryKey, getListWorkspaceFilesQueryKey } from "@workspace/api-client-react";
import { Message } from "@workspace/api-client-react";

interface ForgeWorkspaceProps {
  sessionId: number;
}

export default function ForgeWorkspace({ sessionId }: ForgeWorkspaceProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  
  const { data: sessionData, isLoading: isLoadingSession } = useGetSession(sessionId, { 
    query: { enabled: !!sessionId, queryKey: getGetSessionQueryKey(sessionId) } 
  });

  // The session's GitHub fields aren't in the generated client types yet
  // (OpenAPI spec not regenerated) — read them off the raw payload.
  const ghFields = (sessionData ?? {}) as { githubRepo?: string | null; githubAutopush?: boolean };
  
  const { data: files } = useListWorkspaceFiles(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListWorkspaceFilesQueryKey(sessionId) }
  });

  // Throttled live-refresh of the preview + file list while the agent works.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleWorkspaceRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListWorkspaceFilesQueryKey(sessionId) });
    if (refreshTimerRef.current) return; // one pending bump at a time
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      setPreviewKey((k) => k + 1);
    }, 1000);
  }, [queryClient, sessionId]);
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  // File uploads: land in the session workspace so the agent can read them.
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  // Counter, not boolean: overlapping batches (drop while picker uploads
  // run) must not clear the busy state early.
  const [uploadingCount, setUploadingCount] = useState(0);
  const isUploading = uploadingCount > 0;
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const all = Array.from(fileList);
    if (!all.length) return;
    setUploadError(null);
    const tooBig = all.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const candidates = all.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    const failed: string[] = tooBig.map((f) => `${f.name} (over 25MB)`);
    const uploaded: string[] = [];
    const putOne = async (file: File) => {
      try {
        const res = await fetch(
          `${import.meta.env.BASE_URL}api/sessions/${sessionId}/files/${encodeURIComponent(file.name)}`,
          {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        uploaded.push(file.name);
      } catch {
        failed.push(file.name);
      }
    };
    setUploadingCount((c) => c + 1);
    try {
      // Bounded concurrency: the server buffers each body in memory, so
      // don't fire 50 parallel 25MB PUTs when a folder gets dropped.
      const queue = [...candidates];
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let f = queue.shift(); f; f = queue.shift()) await putOne(f);
        }),
      );
    } finally {
      setUploadingCount((c) => c - 1);
    }
    if (uploaded.length) {
      setAttachedFiles((prev) => [...prev, ...uploaded.filter((n) => !prev.includes(n))]);
      queryClient.invalidateQueries({ queryKey: getListWorkspaceFilesQueryKey(sessionId) });
    }
    if (failed.length) setUploadError(`Failed to upload: ${failed.join(", ")}`);
  }, [sessionId, queryClient]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes("Files")) {
      dragCounter.current++;
      setIsDragging(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  };

  // Paste a screen capture straight into the composer: clipboard images are
  // uploaded like dropped files. Clipboard files all arrive named "image.png",
  // so they get unique timestamped names to avoid overwriting each other.
  const handlePaste = (e: React.ClipboardEvent) => {
    let images = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    // Some Safari/Firefox paths expose pasted files on .files, not .items.
    if (!images.length) {
      images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    }
    if (!images.length) return; // plain text paste: leave the default alone
    // Rich clipboards can carry text alongside an image; only swallow the
    // paste when there is no text to insert.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const rand = Math.random().toString(36).slice(2, 6);
    uploadFiles(
      images.map((f, i) => {
        const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
        const suffix = images.length > 1 ? `-${i + 1}` : "";
        return new File([f], `pasted-${stamp}-${rand}${suffix}.${ext}`, { type: f.type });
      }),
    );
  };

  const WRITE_TOOLS = ["create_file", "edit_file", "run_command"];
  const refreshWorkspaceState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: getListWorkspaceFilesQueryKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: ["checkpoints", sessionId] });
    setPreviewKey((k) => k + 1);
  }, [queryClient, sessionId]);

  const [architectMode, setArchitectMode] = useState(false);
  const { data: capabilities } = useGetCapabilities();
  const { sendChat, sendReview, isStreaming, streamingText, streamingThinking, activeToolCall, error, stopStream, isArchitectTurn, isReviewTurn } = useChatStream({
    sessionId,
    onDone: refreshWorkspaceState,
    onToolResult: (name) => {
      if (WRITE_TOOLS.includes(name)) scheduleWorkspaceRefresh();
    },
    onStopped: () => {
      // The server persists the partial turn + a checkpoint after the socket
      // drops; refresh twice to catch both.
      setTimeout(refreshWorkspaceState, 400);
      setTimeout(refreshWorkspaceState, 1500);
    },
  });

  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewToken, setPreviewToken] = useState<string | null>(null);

  // The preview iframe is sandboxed, so browsers drop the session cookie for
  // its requests — access is granted via a signed token in the URL instead.
  useEffect(() => {
    if (!showPreview) return;
    fetch(`${import.meta.env.BASE_URL}api/sessions/${sessionId}/preview-token`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setPreviewToken(d.token))
      .catch(() => setPreviewToken(null));
    // previewKey in deps: every reload (manual or live-refresh) gets a fresh
    // short-lived token, so an open preview never outlives its token.
  }, [showPreview, sessionId, previewKey]);

  const previewUrl = previewToken
    ? `${import.meta.env.BASE_URL}api/sessions/${sessionId}/preview/${previewToken}/`
    : null;

  const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const readFile = useReadWorkspaceFile();
  const [fileContent, setFileContent] = useState<{content: string, language: string} | null>(null);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [sideTab, setSideTab] = useState<"files" | "checkpoints" | "terminal">("files");

  const handleSaveFile = async () => {
    if (selectedFile === null || editDraft === null) return;
    setIsSavingFile(true);
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}api/sessions/${sessionId}/file`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content: editDraft }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setFileContent((fc) => (fc ? { ...fc, content: editDraft } : fc));
      setEditDraft(null);
      queryClient.invalidateQueries({ queryKey: getListWorkspaceFilesQueryKey(sessionId) });
      setPreviewKey((k) => k + 1);
    } catch {
      // Keep the draft so nothing typed is lost; the user can retry.
    } finally {
      setIsSavingFile(false);
    }
  };

  useEffect(() => {
    setEditDraft(null); // switching files discards any unsaved draft
    if (selectedFile) {
      if (IMAGE_FILE_RE.test(selectedFile)) {
        setFileContent(null); // images render straight from the raw endpoint
        return;
      }
      readFile.mutate({ id: sessionId, data: { path: selectedFile } }, {
        onSuccess: (data) => {
          setFileContent({ content: data.content, language: data.language });
        }
      });
    } else {
      setFileContent(null);
    }
  }, [selectedFile, sessionId]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      const scrollElement = chatScrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [sessionData?.messages, streamingText, activeToolCall]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    // Block send mid-upload so the attachment note never misses in-flight files.
    if ((!trimmed && attachedFiles.length === 0) || isStreaming || isUploading) return;

    // Mention freshly uploaded files so the agent knows to look for them.
    // Image attachments get an explicit nudge toward the vision tool — local
    // models won't reliably think to look otherwise.
    const hasImages = attachedFiles.some((n) => /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i.test(n));
    const attachNote = attachedFiles.length
      ? `[Uploaded to the workspace: ${attachedFiles.join(", ")}${hasImages ? " — use analyze_image to view the image(s) before answering" : ""}]`
      : "";
    const messageContent = [attachNote, trimmed].filter(Boolean).join("\n\n");
    setInput("");
    setAttachedFiles([]);
    sendChat(messageContent, { architect: architectMode });
  };

  // Retry / edit the last user message: the server deletes that message and
  // everything after it; retry resends the same content, edit refills input.
  const deleteFromMessage = async (messageId: number) => {
    await fetch(`${import.meta.env.BASE_URL}api/sessions/${sessionId}/messages/${messageId}`, {
      method: "DELETE",
      credentials: "include",
    });
    await queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
  };
  const handleRetry = async (messageId: number, content: string) => {
    if (isStreaming || isUploading) return;
    await deleteFromMessage(messageId);
    sendChat(content, { architect: architectMode });
  };
  const handleEditLast = async (messageId: number, content: string) => {
    if (isStreaming || isUploading) return;
    await deleteFromMessage(messageId);
    setInput(content);
  };

  // One-click handoff: after an architect plan, have the coding agent build it.
  const handleBuildPlan = () => {
    if (isStreaming || isUploading) return;
    setArchitectMode(false);
    sendChat(
      "Implement the architect's plan from the previous message: create and edit every file it specifies using your tools, then verify your work. Do not restate the plan.",
      { architect: false },
    );
  };

  if (isLoadingSession) {
    return <div className="flex-1 flex items-center justify-center text-primary font-mono"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  if (!sessionData) {
    return <div className="flex-1 flex items-center justify-center text-destructive font-mono">Failed to mount session</div>;
  }

  // Parse historical tool calls safely
  const renderMessageContent = (msg: Message) => {
    if (msg.role === "tool") {
      // It's a tool result
      let resultObj;
      try {
        resultObj = JSON.parse(msg.content);
      } catch (e) {
        // Not JSON, just show text
        return (
          <div className="bg-sidebar-accent/30 border border-sidebar-border rounded p-2 mt-1 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-muted-foreground">
            {msg.content.substring(0, 500)}{msg.content.length > 500 ? "...\n[TRUNCATED]" : ""}
          </div>
        );
      }

      const isError = resultObj.isError || false;
      const content = resultObj.result || msg.content;
      
      return (
        <div className={cn(
          "rounded border p-2 mt-1 text-xs font-mono overflow-x-auto whitespace-pre-wrap",
          isError ? "bg-destructive/10 border-destructive/30 text-destructive" : "bg-sidebar-accent/30 border-sidebar-border text-muted-foreground"
        )}>
          {typeof content === 'string' ? content.substring(0, 500) + (content.length > 500 ? "...\n[TRUNCATED]" : "") : JSON.stringify(content, null, 2)}
        </div>
      );
    }

    if (msg.role === "assistant" && msg.toolCalls) {
      // It's an assistant message that MIGHT have text AND tool calls
      let calls: any[] = [];
      try {
        calls = typeof msg.toolCalls === 'string' ? JSON.parse(msg.toolCalls) : msg.toolCalls;
      } catch (e) {
        console.error("Failed to parse tool calls", e);
      }

      return (
        <div className="space-y-2">
          {msg.content && <div className="whitespace-pre-wrap text-sm">{msg.content}</div>}
          {calls && calls.length > 0 && (
            <div className="space-y-2 mt-2">
              {calls.map((call: any, idx: number) => (
                <div key={idx} className="flex flex-col bg-card border border-border rounded-sm overflow-hidden">
                  <div className="bg-muted px-3 py-1.5 flex items-center gap-2 border-b border-border">
                    <Terminal className="w-3.5 h-3.5 text-primary" />
                    <span className="font-mono text-xs font-bold text-foreground">
                      {call.function?.name || 'unknown_tool'}
                    </span>
                  </div>
                  <div className="p-3 bg-background font-mono text-xs text-muted-foreground overflow-x-auto whitespace-pre">
                    {call.function?.arguments || '{}'}
                  </div>
                  {call.function?.name === "generate_image" && (() => {
                    try {
                      const imgPath = JSON.parse(call.function?.arguments || "{}").path;
                      if (typeof imgPath === "string" && imgPath) {
                        return (
                          <img
                            src={`${import.meta.env.BASE_URL}api/sessions/${sessionId}/file/raw?path=${encodeURIComponent(imgPath)}`}
                            alt={imgPath}
                            className="max-h-64 w-auto m-3 mt-2 border border-border rounded-sm"
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        );
                      }
                    } catch { /* unparseable args — skip the thumbnail */ }
                    return null;
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Standard user or plain assistant message
    return <div className="whitespace-pre-wrap text-sm">{msg.content}</div>;
  };

  // Durable architect-handoff gate: derived from persisted messages so it
  // survives reloads and stays session-scoped (client stream state does not).
  const lastMessage = sessionData.messages?.[sessionData.messages.length - 1];
  const showBuildPlan = !isStreaming && lastMessage?.role === "assistant" && lastMessage?.mode === "architect";

  const lastUserMessageId = [...(sessionData.messages ?? [])]
    .reverse()
    .find((m) => m.role === "user")?.id;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* Session Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="font-mono font-bold text-sm tracking-wide flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_rgba(255,122,24,0.6)]"></span>
            {sessionData.title}
          </h2>
          <Badge variant="outline" className="font-mono text-[10px] rounded-sm bg-background border-border text-muted-foreground flex gap-1.5 items-center">
            <Cpu className="w-3 h-3" />
            {sessionData.model}
          </Badge>
        </div>
        <div className="text-xs font-mono text-muted-foreground flex gap-4 items-center">
          <GithubPanel
            sessionId={sessionId}
            sessionTitle={sessionData.title}
            githubRepo={ghFields.githubRepo ?? null}
            githubAutopush={ghFields.githubAutopush ?? false}
          />
          <Button
            variant={showPreview ? "default" : "outline"}
            size="sm"
            onClick={() => setShowPreview((v) => !v)}
            className="h-7 font-mono tracking-widest text-[10px] rounded-sm px-3 gap-1.5"
          >
            <Globe className="w-3.5 h-3.5" />
            {showPreview ? "HIDE PREVIEW" : "PREVIEW"}
          </Button>
          <span className="flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5" /> WORKSPACE MOUNTED</span>
          <span>//</span>
          <span>{formatDate(sessionData.updatedAt)}</span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Live Site Preview (side by side with chat) */}
        {showPreview && (
          <div className="flex-1 flex flex-col border-r border-border bg-background min-w-[320px]">
            <div className="h-9 border-b border-border bg-muted/50 flex items-center justify-between px-3 shrink-0">
              <span className="font-mono text-[10px] font-bold tracking-widest text-muted-foreground flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-primary" /> LIVE_PREVIEW
              </span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="w-6 h-6" title="Reload preview" onClick={() => setPreviewKey((k) => k + 1)}>
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="w-6 h-6" title="Open in new tab" disabled={!previewUrl} onClick={() => previewUrl && window.open(previewUrl, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
            {previewUrl ? (
              <iframe
                src={previewUrl}
                title="Workspace preview"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-forms"
                className="flex-1 w-full bg-white"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              </div>
            )}
          </div>
        )}

        {/* Main Chat Area */}
        <div
          className={cn("flex-1 flex flex-col border-r border-border bg-background relative", showPreview ? "min-w-[320px]" : "min-w-[400px]")}
          onDragEnter={handleDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-0 z-30 bg-background/90 border-2 border-dashed border-primary rounded-sm m-2 flex flex-col items-center justify-center gap-3 pointer-events-none">
              <Upload className="w-10 h-10 text-primary" />
              <p className="font-mono text-sm font-bold tracking-widest text-primary">DROP FILES TO UPLOAD</p>
              <p className="font-mono text-[10px] text-muted-foreground">Files land in the session workspace for the agent to use</p>
            </div>
          )}
          <ScrollArea ref={chatScrollRef} className="flex-1 p-6">
            <div className="space-y-6 max-w-3xl mx-auto pb-12">
              
              {/* Intro message */}
              {sessionData.messages?.length === 0 && !isStreaming && (
                <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                  <div className="w-16 h-16 rounded-sm bg-card border border-border flex items-center justify-center text-primary shadow-sm">
                    <Terminal className="w-8 h-8" />
                  </div>
                  <h3 className="font-mono font-bold text-lg tracking-tight">AGENT INITIALIZED</h3>
                  <p className="text-sm text-muted-foreground max-w-sm font-mono leading-relaxed">
                    Ready for input. I can write code, create files, and execute terminal commands in this secure environment.
                  </p>
                </div>
              )}

              {/* Message History */}
              {sessionData.messages?.map((msg) => (
                <div 
                  key={msg.id} 
                  className={cn(
                    "flex flex-col gap-1 max-w-[95%]",
                    msg.role === "user" ? "ml-auto" : "mr-auto"
                  )}
                >
                  <div className="flex items-center gap-2 text-[10px] font-mono font-bold text-muted-foreground tracking-wider uppercase mb-1">
                    {msg.role === "user" ? (
                      <>USER_INPUT <CornerDownRight className="w-3 h-3" /></>
                    ) : msg.role === "tool" ? (
                      <><Terminal className="w-3 h-3" /> SYSTEM_RETURN</>
                    ) : (
                      <><Cpu className="w-3 h-3 text-primary" /> AGENT_PROCESS</>
                    )}
                  </div>
                  
                  <div className={cn(
                    "rounded-sm px-4 py-3 border shadow-sm",
                    msg.role === "user" 
                      ? "bg-primary text-primary-foreground border-primary" 
                      : msg.role === "tool"
                      ? "bg-background border-border"
                      : "bg-card border-card-border text-card-foreground"
                  )}>
                    {renderMessageContent(msg)}
                  </div>

                  {msg.role === "user" && msg.id === lastUserMessageId && !isStreaming && (
                    <div className="flex gap-1 justify-end mt-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 font-mono text-[9px] tracking-widest text-muted-foreground hover:text-primary"
                        title="Delete the agent's response and run this message again"
                        onClick={() => handleRetry(msg.id, msg.content)}
                      >
                        <RotateCcw className="w-3 h-3 mr-1" /> RETRY
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 font-mono text-[9px] tracking-widest text-muted-foreground hover:text-primary"
                        title="Delete this message and its response, then edit it"
                        onClick={() => handleEditLast(msg.id, msg.content)}
                      >
                        <Pencil className="w-3 h-3 mr-1" /> EDIT
                      </Button>
                    </div>
                  )}
                </div>
              ))}

              {/* Active Stream Area */}
              {isStreaming && (
                <div className="flex flex-col gap-1 max-w-[95%] mr-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="flex items-center gap-2 text-[10px] font-mono font-bold text-muted-foreground tracking-wider uppercase mb-1">
                    {isArchitectTurn ? (
                      <><Brain className="w-3 h-3 text-primary animate-pulse" /> ARCHITECT_PROCESS</>
                    ) : isReviewTurn ? (
                      <><ShieldCheck className="w-3 h-3 text-primary animate-pulse" /> CLAUDE_REVIEW</>
                    ) : (
                      <><Cpu className="w-3 h-3 text-primary animate-pulse" /> AGENT_PROCESS</>
                    )}
                  </div>
                  
                  <div className="space-y-3 w-full">
                    {/* Architect reasoning trace (ephemeral — display only) */}
                    {streamingThinking && (
                      <div className="bg-background border border-border/60 rounded-sm px-4 py-3 text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                        <span className="block text-[9px] font-bold tracking-widest text-primary/70 mb-1.5">REASONING</span>
                        {streamingThinking}
                      </div>
                    )}
                    {/* Streaming Text */}
                    {streamingText && (
                      <div className="bg-card border border-card-border text-card-foreground rounded-sm px-4 py-3 shadow-sm text-sm whitespace-pre-wrap">
                        {streamingText}
                        <span className="inline-block w-1.5 h-3.5 bg-primary ml-1 animate-pulse align-middle" />
                      </div>
                    )}
                    
                    {/* Active Tool Call */}
                    {activeToolCall && (
                      <div className="flex flex-col bg-card border border-primary/50 rounded-sm overflow-hidden shadow-[0_0_15px_rgba(255,122,24,0.1)]">
                        <div className="bg-primary/10 px-3 py-2 flex items-center gap-2 border-b border-primary/20">
                          <Loader2 className="w-4 h-4 text-primary animate-spin" />
                          <span className="font-mono text-xs font-bold text-primary tracking-wide">
                            EXECUTING: {activeToolCall.name}
                          </span>
                        </div>
                        <div className="p-3 bg-background font-mono text-xs text-muted-foreground overflow-x-auto whitespace-pre">
                          {activeToolCall.arguments}
                        </div>
                      </div>
                    )}

                    {/* Waiting state before anything streams */}
                    {!streamingText && !streamingThinking && !activeToolCall && (
                      <div className="flex items-center gap-3 text-muted-foreground text-sm font-mono italic">
                        <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        {isArchitectTurn ? "Architect is thinking..." : isReviewTurn ? "Claude is reviewing this session\u2019s work..." : "Generating response..."}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Error Display */}
              {error && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-sm p-4 text-destructive flex gap-3 text-sm font-mono items-start">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div className="leading-relaxed whitespace-pre-wrap">
                    <span className="font-bold block mb-1">ERROR DETECTED</span>
                    {error}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input Area */}
          <div className="p-4 bg-card border-t border-border shrink-0">
            {showBuildPlan && (
              <div className="max-w-3xl mx-auto mb-2">
                <button
                  type="button"
                  onClick={handleBuildPlan}
                  className="w-full flex items-center justify-center gap-2 bg-primary/10 border border-primary/40 hover:bg-primary/20 text-primary rounded-sm px-3 py-2 text-xs font-mono font-bold transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  BUILD THIS PLAN — hand off to the coding agent
                </button>
              </div>
            )}
            {(attachedFiles.length > 0 || uploadError) && (
              <div className="max-w-3xl mx-auto mb-2 space-y-1.5">
                {attachedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {attachedFiles.map((name) => (
                      <span key={name} className="inline-flex items-center gap-1.5 bg-primary/10 border border-primary/30 text-foreground rounded-sm px-2 py-1 text-[10px] font-mono">
                        <Paperclip className="w-3 h-3 text-primary" />
                        {name}
                        <button
                          type="button"
                          title="Don't mention in next message (file stays in workspace)"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => setAttachedFiles((p) => p.filter((n) => n !== name))}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <span className="text-[9px] font-mono text-muted-foreground tracking-wider">IN WORKSPACE — WILL BE MENTIONED TO AGENT</span>
                  </div>
                )}
                {uploadError && (
                  <p className="text-[10px] font-mono text-destructive flex items-center gap-1.5">
                    <AlertCircle className="w-3 h-3 shrink-0" /> {uploadError}
                  </p>
                )}
              </div>
            )}
            <form onSubmit={handleSubmit} className="max-w-3xl mx-auto relative group">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) uploadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="absolute left-3 top-3 text-muted-foreground group-focus-within:text-primary transition-colors">
                <ChevronRight className="w-5 h-5" />
              </div>
              <Input 
                value={input}
                onChange={e => setInput(e.target.value)}
                onPaste={handlePaste}
                placeholder={architectMode ? "Deep-dive question for the architect (no file edits)..." : attachedFiles.length ? "What should I do with these files?" : "Command sequence or natural language instruction..."}
                className="w-full pl-10 pr-36 py-6 bg-background border-2 border-input focus-visible:border-primary focus-visible:ring-0 rounded-sm font-mono text-sm shadow-sm transition-all"
                disabled={isStreaming}
                autoFocus
              />
              <div className="absolute right-2 top-2 flex items-center gap-1">
                {isStreaming && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => stopStream()}
                    title="Stop the agent (cancels generation and running commands)"
                    className="h-8 font-mono tracking-widest text-[10px] rounded-sm px-3 gap-1.5"
                  >
                    <Square className="w-3 h-3 fill-current" /> STOP
                  </Button>
                )}
                {capabilities?.review && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={isStreaming || isUploading}
                    title={`Send for review \u2014 ${capabilities.reviewModel ?? "Claude"} audits everything this session changed`}
                    onClick={() => sendReview()}
                    className="h-8 w-8 rounded-sm text-muted-foreground hover:text-primary"
                  >
                    <ShieldCheck className="w-4 h-4" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant={architectMode ? "default" : "ghost"}
                  size="icon"
                  title={architectMode ? "Architect mode ON — this message goes to the reasoning model for a deep dive (no file edits)" : "Architect mode: discuss design and plans with the reasoning model"}
                  onClick={() => setArchitectMode((v) => !v)}
                  className={cn("h-8 w-8 rounded-sm", !architectMode && "text-muted-foreground hover:text-primary")}
                >
                  <Brain className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Upload files to workspace"
                  disabled={isUploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 w-8 rounded-sm text-muted-foreground hover:text-primary"
                >
                  {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                </Button>
                <Button 
                  type="submit" 
                  size="sm"
                  disabled={(!input.trim() && !attachedFiles.length) || isStreaming || isUploading}
                  className="h-8 font-mono tracking-widest text-[10px] bg-primary text-primary-foreground hover:bg-primary/90 rounded-sm px-4"
                >
                  {isStreaming ? "PROCESSING" : isUploading ? "UPLOADING" : "SUBMIT"}
                  {!isStreaming && !isUploading && <Send className="w-3 h-3 ml-2 -mr-1" />}
                </Button>
              </div>
            </form>
          </div>
        </div>

        {/* Workspace Sidebar */}
        <div className="w-80 flex flex-col bg-card shrink-0 shadow-[-10px_0_15px_-5px_rgba(0,0,0,0.05)] z-10 relative">
          
          {/* File Viewer Modal equivalent (shown in sidebar for density) */}
          {selectedFile && (
            <div className="absolute inset-0 bg-card z-20 flex flex-col">
              <div className="h-10 bg-muted border-b border-border flex items-center justify-between px-3 shrink-0">
                <div className="flex items-center gap-2 overflow-hidden">
                  <FileCode2 className="w-4 h-4 text-primary shrink-0" />
                  <span className="font-mono text-xs font-medium truncate">{selectedFile.split('/').pop()}</span>
                </div>
                <div className="flex items-center gap-1">
                  {fileContent && !readFile.isPending && (
                    editDraft === null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 font-mono text-[9px] tracking-widest text-muted-foreground hover:text-primary"
                        onClick={() => setEditDraft(fileContent.content)}
                      >
                        <Pencil className="w-3 h-3 mr-1" /> EDIT
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isSavingFile}
                          className="h-6 px-2 font-mono text-[9px] tracking-widest text-muted-foreground"
                          onClick={() => setEditDraft(null)}
                        >
                          CANCEL
                        </Button>
                        <Button
                          size="sm"
                          disabled={isSavingFile}
                          className="h-6 px-2 font-mono text-[9px] tracking-widest rounded-sm"
                          onClick={handleSaveFile}
                        >
                          {isSavingFile ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Save className="w-3 h-3 mr-1" /> SAVE</>}
                        </Button>
                      </>
                    )
                  )}
                  <Button variant="ghost" size="icon" className="w-6 h-6 hover:bg-background" onClick={() => setSelectedFile(null)}>
                    <span className="sr-only">Close</span>
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              
              <div className="flex-1 overflow-hidden relative">
                {IMAGE_FILE_RE.test(selectedFile) ? (
                  <ScrollArea className="h-full">
                    <div className="p-4 flex items-start justify-center bg-background min-h-full">
                      <img
                        src={`${import.meta.env.BASE_URL}api/sessions/${sessionId}/file/raw?path=${encodeURIComponent(selectedFile)}`}
                        alt={selectedFile}
                        className="max-w-full h-auto border border-border rounded-sm"
                      />
                    </div>
                  </ScrollArea>
                ) : readFile.isPending ? (
                  <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-6 h-6 text-muted-foreground animate-spin" /></div>
                ) : fileContent ? (
                  editDraft !== null ? (
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      spellCheck={false}
                      autoFocus
                      className="absolute inset-0 w-full h-full p-4 text-[11px] font-mono leading-relaxed bg-background text-foreground resize-none outline-none"
                    />
                  ) : (
                  <ScrollArea className="h-full">
                    <pre className="p-4 text-[11px] font-mono leading-relaxed text-foreground bg-background min-h-full">
                      <code>{fileContent.content}</code>
                    </pre>
                  </ScrollArea>
                  )
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs font-mono">Failed to read file</div>
                )}
              </div>
            </div>
          )}

          <div className="border-b border-border shrink-0 bg-muted/50 flex">
            {([
              { id: "files", label: "FILES", Icon: HardDrive },
              { id: "checkpoints", label: "CHECKPOINTS", Icon: GitCommitHorizontal },
              { id: "terminal", label: "TERMINAL", Icon: SquareTerminal },
            ] as const).map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSideTab(id)}
                className={cn(
                  "flex-1 px-1 py-2.5 font-mono text-[9px] font-bold tracking-widest flex items-center justify-center gap-1 border-b-2 transition-colors",
                  sideTab === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>

          {sideTab === "checkpoints" && (
            <CheckpointsPanel sessionId={sessionId} onReverted={refreshWorkspaceState} />
          )}

          {sideTab === "terminal" && (
            <TerminalPanel
              sessionId={sessionId}
              onWorkspaceChanged={() => {
                queryClient.invalidateQueries({ queryKey: getListWorkspaceFilesQueryKey(sessionId) });
                setPreviewKey((k) => k + 1);
              }}
            />
          )}

          {sideTab === "files" && (
          <>
          <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center justify-between">
            <span className="font-mono text-[9px] tracking-widest text-muted-foreground">
              {files?.length ?? 0} FILE{(files?.length ?? 0) === 1 ? "" : "S"} IN WORKSPACE
            </span>
            {!!files?.length && (
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                title="Download all files as zip"
                onClick={() => { window.location.href = `${import.meta.env.BASE_URL}api/sessions/${sessionId}/download`; }}
              >
                <Download className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
          
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-0.5">
              {!files?.length ? (
                <div className="px-4 py-8 text-center border border-dashed border-border rounded-sm m-2">
                  <p className="text-xs font-mono text-muted-foreground">WORKSPACE EMPTY</p>
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">Files created by the agent will appear here. Drag & drop into chat to upload yours.</p>
                </div>
              ) : (
                files.map(file => (
                  <button
                    key={file.path}
                    onClick={() => file.type === 'file' ? setSelectedFile(file.path) : null}
                    className={cn(
                      "w-full flex items-start gap-2.5 px-3 py-2 text-left rounded-sm transition-colors",
                      file.type === 'file' 
                        ? "hover:bg-muted cursor-pointer group" 
                        : "opacity-60 cursor-default"
                    )}
                  >
                    {file.type === 'file' ? (
                      <FileCode2 className="w-4 h-4 text-primary shrink-0 mt-0.5 group-hover:scale-110 transition-transform" />
                    ) : (
                      <FileText className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    )}
                    <div className="flex flex-col min-w-0 overflow-hidden w-full">
                      <span className="font-mono text-xs font-medium truncate text-foreground/90 leading-tight">
                        {file.name}
                      </span>
                      {file.type === 'file' && (
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-[9px] font-mono text-muted-foreground truncate">{file.path.split('/').slice(0, -1).join('/') || '/'}</span>
                          <span className="text-[9px] font-mono text-muted-foreground shrink-0 ml-2">{formatBytes(file.size)}</span>
                        </div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
          </>
          )}
        </div>
      </div>
    </div>
  );
}