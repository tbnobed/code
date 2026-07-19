import { useEffect, useState, useRef, useCallback } from "react";
import { Message } from "@workspace/api-client-react";

type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string; isError?: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

interface UseChatStreamOptions {
  sessionId: number;
  onDone?: () => void;
}

export function useChatStream({ sessionId, onDone }: UseChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Ephemeral streaming state for UI display before it's saved in DB
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCall, setActiveToolCall] = useState<{name: string, arguments: string} | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);

  const stopStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStreamingText("");
    setActiveToolCall(null);
  }, []);

  const sendChat = useCallback(async (content: string) => {
    if (isStreaming) return;
    
    stopStream(); // Ensure any existing stream is cleaned up
    
    setIsStreaming(true);
    setError(null);
    setStreamingText("");
    setActiveToolCall(null);
    
    abortControllerRef.current = new AbortController();
    
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
        signal: abortControllerRef.current.signal,
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
                  break;
                case "error":
                  setError(event.message);
                  break;
                case "done":
                  if (onDone) onDone();
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
        console.log('Stream aborted');
      } else {
        console.error('Stream error:', err);
        setError(err.message || 'An error occurred during chat');
      }
    } finally {
      setIsStreaming(false);
      setStreamingText("");
      setActiveToolCall(null);
      abortControllerRef.current = null;
    }
  }, [sessionId, isStreaming, stopStream, onDone]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopStream();
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