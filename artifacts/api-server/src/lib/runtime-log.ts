import { redactSecrets } from "./agent-tools";

export function redactRuntime(text: string, values: string[]) {
  let result = redactSecrets(text);
  for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join("[REDACTED]");
  }
  return result;
}
/** Hold incomplete lines so polling cannot reveal half of a secret. Drop
 * oversized lines instead of truncating through a credential. */
export function runtimeLogSink(write: (text: string) => void, values: string[]) {
  let carry = "", dropping = false;
  return {
    push(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        const complete = part.endsWith("\n");
        if (!dropping) carry += part;
        if (carry.length > 65536) { carry = ""; dropping = true; }
        if (complete) {
          write(dropping ? "[oversized log line omitted]\n" : redactRuntime(carry, values));
          carry = ""; dropping = false;
        }
      }
    },
    flush() {
      if (carry && !dropping) write(redactRuntime(carry, values));
      carry = ""; dropping = false;
    },
  };
}