/** Counted-line metric for AIC-ARCH-001. Physical minus blank minus comment-only. */

export function physicalLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function countedLines(text) {
  let inBlock = false;
  let inHtml = false;
  let n = 0;
  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const s = line.trim();
    if (inBlock) {
      if (s.includes("*/")) inBlock = false;
      continue;
    }
    if (inHtml) {
      if (s.includes("-->")) inHtml = false;
      continue;
    }
    if (s === "") continue;
    if (s.startsWith("/*")) {
      if (!s.includes("*/")) inBlock = true;
      continue;
    }
    if (s.startsWith("<!--")) {
      if (!s.includes("-->")) inHtml = true;
      continue;
    }
    if (s.startsWith("//")) continue;
    if (s.startsWith("*") && !/[{};,]/.test(s) && !/^\*(?:[.#:\[]|\/)/.test(s))
      continue;
    n += 1;
  }
  return n;
}
