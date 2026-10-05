import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInWorkspace } from "./workspace";

export const imageFingerprint = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function saveGeneratedImage(dir: string, rel: string, bytes: Buffer) {
  const target = await resolveInWorkspace(dir, rel);
  const sha256 = imageFingerprint(bytes);
  let identicalToPrevious = false;
  try { identicalToPrevious = imageFingerprint(await fs.readFile(target)) === sha256; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const versionPath = `.forge-images/${sha256}.png`;
  const version = await resolveInWorkspace(dir, versionPath);
  await fs.mkdir(path.dirname(version), { recursive: true });
  // Content-addressed copies preserve each generation even when logo.png changes.
  await fs.writeFile(version, bytes);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return { path: versionPath, sha256, identicalToPrevious };
}