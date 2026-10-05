export function filePage(content: string, args: Record<string, unknown>) {
  const number = (key: string, fallback: number) => {
    const value = args[key] === undefined ? fallback : Number(args[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer.`);
    return value;
  };
  const lines = content.split("\n");
  const start = number("start_line", number("offset", 1));
  const end = number("end_line", start + Math.min(number("limit", 200), 400) - 1);
  if (end < start) throw new Error("end_line must be at least start_line.");
  if (start > lines.length) return `File has ${lines.length} lines; requested start_line=${start} is past the end.`;
  const page: string[] = [];
  let size = 0;
  let next = start;
  for (let i = start; i <= Math.min(end, start + 399, lines.length); i++) {
    const row = `${i}: ${lines[i - 1]}`;
    if (row.length > 10000) {
      if (page.length) break;
      return `Line ${i} exceeds the read budget. Use run_command with a targeted search or character slice; repeating this read will not reveal more content.`;
    }
    if (size + row.length > 10000) break;
    page.push(row); size += row.length + 1; next = i + 1;
  }
  return `Lines ${start}–${next - 1} of ${lines.length}.${next <= lines.length ? ` More content: read_file with start_line=${next}.` : " End of file."}\n${page.join("\n")}`;
}