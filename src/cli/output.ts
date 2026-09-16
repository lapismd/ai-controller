/** Human output is deliberately separate from the stable machine envelope. */
export function human(command: string, data: unknown, color = false): string {
  if (typeof data === "string") return data;
  const heading = command
    .split(" ")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" · ");
  const title = color ? `\u001b[1;36m${heading}\u001b[0m` : heading;
  return `${title}\n${render(data, 0)}`;
}
function render(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "  None";
    return value
      .map((item) =>
        typeof item === "object" && item !== null
          ? render(item, depth)
          : `  • ${String(item)}`,
      )
      .join("\n\n");
  }
  const entries = Object.entries(value).filter(
    ([, item]) => item !== undefined,
  );
  const width = Math.min(
    24,
    Math.max(0, ...entries.map(([key]) => label(key).length)),
  );
  return entries
    .map(([key, item]) => {
      const prefix = `${"  ".repeat(depth + 1)}${label(key).padEnd(width)}  `;
      if (item && typeof item === "object")
        return `${prefix.trimEnd()}\n${render(item, depth + 1)}`;
      return `${prefix}${String(item ?? "—").replaceAll("\n", `\n${"  ".repeat(depth + 2)}`)}`;
    })
    .join("\n");
}
function label(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}
