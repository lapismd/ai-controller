import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export async function executable(command: string): Promise<string | null> {
  const paths = /[/\\]/.test(command)
    ? [resolve(command)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((root) => join(root, command));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      const stat = await lstat(path);
      if (stat.isFile() || stat.isSymbolicLink()) return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}
export async function externalCommand(
  command: string | string[],
): Promise<string | string[]> {
  const first = Array.isArray(command)
    ? (command[0] ?? "")
    : (command
        .match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
        ?.slice(1)
        .find(Boolean) ?? "");
  const resolved = await executable(first);
  // acpx must launch the external executable, not infer that this Deno binary is Node.
  if (Array.isArray(command) && resolved)
    return [resolved, ...command.slice(1)];
  const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
  return Array.isArray(command)
    ? command.map(quote).join(" ")
    : command.replace(/^(?:"[^"]+"|'[^']+'|\S+)/, () =>
        quote(resolved ?? first),
      );
}
