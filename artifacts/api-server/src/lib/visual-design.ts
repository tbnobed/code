import fs from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace } from "./workspace";
import { commitTurn } from "./workspace-git";

const marker = "/* Forge visual overrides */";
const keys = new Set(["color", "background-color", "font-size", "font-weight", "line-height", "padding", "margin", "border-radius", "width", "max-width", "text-align"]);
type Rules = Record<string, Record<string, string>>;
const locks = new Map<string, Promise<unknown>>();
async function integration(dir: string) {
  for (const file of ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js", "index.html"]) {
    const full = await resolveInWorkspace(dir, file);
    if (await fs.stat(full).then(s => s.isFile(), () => false)) return { file, full };
  }
  return null;
}
async function load(dir: string): Promise<Rules> {
  try { return JSON.parse(await fs.readFile(await resolveInWorkspace(dir, "forge-design.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
function render(rules: Rules) {
  return marker + "\n" + Object.entries(rules).map(([selector, styles]) =>
    `${selector} {\n${Object.entries(styles).map(([key, value]) => `  ${key}: ${value} !important;`).join("\n")}\n}`).join("\n");
}
export async function visualStatus(dir: string) {
  const supported = !!await integration(dir);
  const rules = await load(dir);
  return { supported, rules, css: render(rules), ...(!supported ? { error: "Visual styles support Next.js App Router and projects with a root index.html. Use the agent for this project structure." } : {}) };
}
export function saveVisualDesign(dir: string, change: { selector: string; styles: Record<string, string> } | null) {
  const previous = locks.get(dir) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const target = await integration(dir);
    if (!target) throw new Error("Unsupported project structure for visual style editing.");
    const rules = await load(dir);
    if (change) {
      if (!change.selector || change.selector.length > 1000 || /[{}<>@\n\r\\]/.test(change.selector)) throw new Error("Unsupported element selector.");
      for (const [key, value] of Object.entries(change.styles)) {
        if (!keys.has(key) || value.length > 100 || !/^[a-zA-Z0-9 .,%#()\-]*$/.test(value) || /url|expression/i.test(value)) throw new Error("Unsupported style property or value.");
      }
      const styles = { ...rules[change.selector] };
      for (const [key, value] of Object.entries(change.styles)) {
        if (value.trim()) styles[key] = value;
        else delete styles[key];
      }
      if (Object.keys(styles).length) rules[change.selector] = styles;
      else delete rules[change.selector];
      if (Object.keys(rules).length > 200) throw new Error("Limit of 200 visual overrides reached.");
    }
    const css = render(change ? rules : {});
    const cssPath = await resolveInWorkspace(dir, "forge-design.css");
    const existing = await fs.readFile(cssPath, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing !== null && !existing.startsWith(marker)) throw new Error("forge-design.css already exists and is not managed by Forge. Rename it before using the visual editor.");
    let source = await fs.readFile(target.full, "utf8");
    if (!source.includes("forge-design.css")) {
      if (target.file === "index.html") {
        const link = '<link rel="stylesheet" href="./forge-design.css">';
        source = source.includes("</head>") ? source.replace("</head>", link + "\n</head>") : link + "\n" + source;
      } else {
        let relative = path.relative(path.dirname(target.full), cssPath).split(path.sep).join("/");
        if (!relative.startsWith(".")) relative = "./" + relative;
        // Append the import: preserve a leading "use client" directive.
        source += `\nimport ${JSON.stringify(relative)};\n`;
      }
    }
    await commitTurn(dir, "before visual style edit");
    await fs.writeFile(cssPath, css);
    await fs.writeFile(await resolveInWorkspace(dir, "forge-design.json"), JSON.stringify(change ? rules : {}, null, 2) + "\n");
    await fs.writeFile(target.full, source);
    return { css, checkpoint: await commitTurn(dir, change ? "visual style edit" : "reset visual styles") };
  });
  locks.set(dir, operation);
  void operation.finally(() => { if (locks.get(dir) === operation) locks.delete(dir); }).catch(() => {});
  return operation;
}