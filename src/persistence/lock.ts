import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ControllerError } from "../contracts.js";

export function acquireWriter(path: string): () => void {
  if (path === ":memory:") return () => {};
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.writer`;
  const identity = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readFileSync(lock, "utf8");
      let pid: unknown;
      try {
        pid = (JSON.parse(current) as { pid: unknown }).pid;
      } catch {
        /* Incomplete lock is owned until explicitly repaired. */
      }
      if (!Number.isSafeInteger(pid))
        throw new ControllerError(
          "writer_locked",
          "Database writer lock is invalid; inspect before recovery",
        );
      try {
        process.kill(pid as number, 0);
      } catch (signalError) {
        if (
          (signalError as NodeJS.ErrnoException).code === "ESRCH" &&
          readFileSync(lock, "utf8") === current
        ) {
          unlinkSync(lock);
          continue;
        }
      }
      throw new ControllerError(
        "writer_locked",
        "Database already has a writer",
      );
    }
    writeFileSync(fd, JSON.stringify(identity));
    closeSync(fd);
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    return () => {
      if (
        existsSync(lock) &&
        readFileSync(lock, "utf8") === JSON.stringify(identity)
      )
        unlinkSync(lock);
    };
  }
  throw new ControllerError(
    "writer_locked",
    "Could not acquire database writer",
  );
}
