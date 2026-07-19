import { useEffect, useState, useRef, useCallback } from "react";

type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string; isError?: boolean }
  | { type: "checkpoint"; hash: string }
  | { type: "done" }
  | { type: "error"; message: string };

interface UseChatStreamOptions {
  sessionId: number;
  onDone?: () => void;
  /** Fired after each tool finishes executing (name = tool name). */
  onToolResult?: (name: string, isError?: boolean) => void;
  /** Fired when the user stops an in-flight turn (not on normal completion). */
  onStopped?: () => void;
}

export function useChatStream({ sessionId, onDone, onToolResult, onStopped }: UseChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ephemeral streaming state for UI display before it's saved in DB
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCall, setActiveToolCall] = useState<{name: string, arguments: string} | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Callbacks live in refs so sendChat/stopStream keep a stable identity even
  // when callers pass inline closures. Without this, the unmount-cleanup
  // effect would re-run on every render and abort live streams.
  const onDoneRef = useRef(onDone);
  const onToolResultRef = useRef(onToolResult);
  const onStoppedRef = useRef(onStopped);
  useEffect(() => {
    onDoneRef.current = onDone;
    onToolResultRef.current = onToolResult;
    onStoppedRef.current = onStopped;
  });

  const stopStream = useCallback((opts?: { silent?: boolean }) => {
    const hadStream = abortControllerRef.current !== null;
    if (abortControllerRef.current) {
      // Aborting closes the SSE socket; the server notices and cancels the
      // whole turn (model generation + running tools).
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStreamingText("");
    setActiveToolCall(null);
    if (hadStream && !opts?.silent) onStoppedRef.current?.();
  }, []);

  const sendChat = useCallback(async (content: string) => {
    if (abortControllerRef.current) return; // a turn is already in flight

    const ac = new AbortController();
    abortControllerRef.current = ac;
    setIsStreaming(true);
    setError(null);
    setStreamingText("");
    setActiveToolCall(null);

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
        signal: ac.signal,
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No readable stream returned");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;

            try {
              const event: StreamEvent = JSON.parse(dataStr);

              switch (event.type) {
                case "text":
                  setStreamingText(prev => prev + event.content);
                  break;
                case "tool_call":
                  setActiveToolCall({ name: event.name, arguments: event.arguments });
                  break;
                case "tool_result":
                  setActiveToolCall(null);
                  onToolResultRef.current?.(event.name, event.isError);
                  break;
                case "error":
                  setError(event.message);
                  break;
                case "done":
                  onDoneRef.current?.();
                  break;
              }
            } catch (e) {
              console.error("Failed to parse SSE event:", e);
            }
          }
        }
      }

    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Stopped by user or unmount — stopStream already reset the UI state.
      } else if (abortControllerRef.current === ac) {
        console.error('Stream error:', err);
        setError(err.message || 'An error occurred during chat');
      }
    } finally {
      // Only the still-active request may clear shared state: a stopped
      // request's late `finally` must not clobber a newer stream.
      if (abortControllerRef.current === ac) {
        abortControllerRef.current = null;
        setIsStreaming(false);
        setStreamingText("");
        setActiveToolCall(null);
      }
    }
  }, [sessionId]);

  // Cleanup on unmount only (stopStream is referentially stable).
  useEffect(() => {
    return () => {
      stopStream({ silent: true });
    };
  }, [stopStream]);

  return {
    sendChat,
    isStreaming,
    streamingText,
    activeToolCall,
    error,
    stopStream
  };
}
