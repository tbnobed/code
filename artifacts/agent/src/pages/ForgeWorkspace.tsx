import { useState, useRef, useEffect } from "react";
import { useGetSession, useListWorkspaceFiles, useReadWorkspaceFile } from "@workspace/api-client-react";
import { Terminal, Send, Cpu, FileCode2, HardDrive, Loader2, AlertCircle, FileText, ChevronRight, CornerDownRight } from "lucide-react";
import { useChatStream } from "@/hooks/use-chat-stream";
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
  
  const { data: files } = useListWorkspaceFiles(sessionId, {
    query: { enabled: !!sessionId, queryKey: getListWorkspaceFilesQueryKey(sessionId) }
  });

  const { sendChat, isStreaming, streamingText, activeToolCall, error } = useChatStream({
    sessionId,
    onDone: () => {
      queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: getListWorkspaceFilesQueryKey(sessionId) });
    }
  });

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const readFile = useReadWorkspaceFile();
  const [fileContent, setFileContent] = useState<{content: string, language: string} | null>(null);

  useEffect(() => {
    if (selectedFile) {
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
    if (!input.trim() || isStreaming) return;
    
    // Optimistic update could go here if we had a full query cache setup, 
    // but the streaming hook gives us good enough UI feedback
    const messageContent = input;
    setInput("");
    sendChat(messageContent);
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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* Session Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="font-mono font-bold text-sm tracking-wide flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_rgba(255,87,34,0.6)]"></span>
            {sessionData.title}
          </h2>
          <Badge variant="outline" className="font-mono text-[10px] rounded-sm bg-background border-border text-muted-foreground flex gap-1.5 items-center">
            <Cpu className="w-3 h-3" />
            {sessionData.model}
          </Badge>
        </div>
        <div className="text-xs font-mono text-muted-foreground flex gap-4">
          <span className="flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5" /> WORKSPACE MOUNTED</span>
          <span>//</span>
          <span>{formatDate(sessionData.updatedAt)}</span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col border-r border-border bg-background min-w-[400px]">
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
                </div>
              ))}

              {/* Active Stream Area */}
              {isStreaming && (
                <div className="flex flex-col gap-1 max-w-[95%] mr-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="flex items-center gap-2 text-[10px] font-mono font-bold text-muted-foreground tracking-wider uppercase mb-1">
                    <Cpu className="w-3 h-3 text-primary animate-pulse" /> AGENT_PROCESS
                  </div>
                  
                  <div className="space-y-3 w-full">
                    {/* Streaming Text */}
                    {streamingText && (
                      <div className="bg-card border border-card-border text-card-foreground rounded-sm px-4 py-3 shadow-sm text-sm whitespace-pre-wrap">
                        {streamingText}
                        <span className="inline-block w-1.5 h-3.5 bg-primary ml-1 animate-pulse align-middle" />
                      </div>
                    )}
                    
                    {/* Active Tool Call */}
                    {activeToolCall && (
                      <div className="flex flex-col bg-card border border-primary/50 rounded-sm overflow-hidden shadow-[0_0_15px_rgba(255,87,34,0.1)]">
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
                    {!streamingText && !activeToolCall && (
                      <div className="flex items-center gap-3 text-muted-foreground text-sm font-mono italic">
                        <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        Generating response...
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
            <form onSubmit={handleSubmit} className="max-w-3xl mx-auto relative group">
              <div className="absolute left-3 top-3 text-muted-foreground group-focus-within:text-primary transition-colors">
                <ChevronRight className="w-5 h-5" />
              </div>
              <Input 
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Command sequence or natural language instruction..."
                className="w-full pl-10 pr-24 py-6 bg-background border-2 border-input focus-visible:border-primary focus-visible:ring-0 rounded-sm font-mono text-sm shadow-sm transition-all"
                disabled={isStreaming}
                autoFocus
              />
              <Button 
                type="submit" 
                size="sm"
                disabled={!input.trim() || isStreaming}
                className="absolute right-2 top-2 h-8 font-mono tracking-widest text-[10px] bg-primary text-primary-foreground hover:bg-primary/90 rounded-sm px-4"
              >
                {isStreaming ? "PROCESSING" : "SUBMIT"}
                {!isStreaming && <Send className="w-3 h-3 ml-2 -mr-1" />}
              </Button>
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
                <Button variant="ghost" size="icon" className="w-6 h-6 hover:bg-background" onClick={() => setSelectedFile(null)}>
                  <span className="sr-only">Close</span>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
              
              <div className="flex-1 overflow-hidden relative">
                {readFile.isPending ? (
                  <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-6 h-6 text-muted-foreground animate-spin" /></div>
                ) : fileContent ? (
                  <ScrollArea className="h-full">
                    <pre className="p-4 text-[11px] font-mono leading-relaxed text-foreground bg-background min-h-full">
                      <code>{fileContent.content}</code>
                    </pre>
                  </ScrollArea>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs font-mono">Failed to read file</div>
                )}
              </div>
            </div>
          )}

          <div className="p-3 border-b border-border shrink-0 bg-muted/50">
            <h3 className="font-mono text-xs font-bold tracking-widest text-muted-foreground flex items-center gap-2">
              <HardDrive className="w-3.5 h-3.5" />
              WORKSPACE_FILES
            </h3>
          </div>
          
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-0.5">
              {!files?.length ? (
                <div className="px-4 py-8 text-center border border-dashed border-border rounded-sm m-2">
                  <p className="text-xs font-mono text-muted-foreground">WORKSPACE EMPTY</p>
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">Files created by the agent will appear here.</p>
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
        </div>
      </div>
    </div>
  );
}