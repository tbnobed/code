export function generatedImagePreview(content?: string): string | null {
  if (!content) return null;
  try {
    const wrapped = JSON.parse(content);
    if (typeof wrapped.result === "string") content = wrapped.result;
  } catch { /* Tool results may be plain text. */ }
  const match = content!.match(/(?:^|\n)Image artifact: (\{[^\n]+\})/);
  if (!match) return null;
  try {
    const artifact = JSON.parse(match[1]);
    return /^[a-f0-9]{64}$/.test(artifact.sha256) && artifact.path === `.forge-images/${artifact.sha256}.png`
      ? artifact.path : null;
  } catch { return null; }
}