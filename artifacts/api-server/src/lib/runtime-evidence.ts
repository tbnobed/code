export interface RuntimeEvidence {
  state: string;
  error: string;
  logs: string;
  diagnostics: { expectedPort: number | null; phase: string };
}

/** Deterministic facts, not the model's interpretation of startup text. */
export function runtimeFacts(status: RuntimeEvidence): string {
  const ports = [...status.logs.slice(-4000).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/g)]
    .map(m => Number(m[1]));
  const reported = [...new Set(ports)];
  const expected = status.diagnostics.expectedPort;
  const mismatch = expected && reported.length && !reported.includes(expected);
  return [
    `Runtime state=${status.state}; phase=${status.diagnostics.phase}; assigned PORT=${expected ?? "not assigned"}.`,
    reported.length ? `Startup-log ports=${reported.join(",")} (log reports, not verified listeners).` : "",
    mismatch ? "PORT MISMATCH: startup logs do not report the assigned port. Inspect the listen call, use process.env.PORT and process.env.HOST, then restart the managed runtime. Do not validate a different localhost port." : "",
    status.error ? `Exact runtime error: ${status.error.slice(0, 650)}` : "",
    "Only verify_runtime checks the signed preview. HTTP success does not prove images, booking, payments or admin functionality.",
  ].filter(Boolean).join("\n");
}

export function wrongRuntimeProbe(command: string, status: RuntimeEvidence): string | null {
  const expected = status.diagnostics.expectedPort;
  if (!expected || !["starting", "error"].includes(status.state) || !/\b(curl|wget)\b/.test(command)) return null;
  const ports = [...command.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/g)].map(m => Number(m[1]));
  if (!ports.some(port => port !== expected)) return null;
  return `Blocked a localhost HTTP probe outside this project's assigned PORT=${expected}. Use get_runtime_status and verify_runtime for application validation. For an intentional separate backend check, explicitly configure that backend and use its managed diagnostics.\n${runtimeFacts(status)}`;
}