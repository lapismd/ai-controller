import { ControllerError } from "../contracts.js";
import type { StoreHost } from "./store-host.js";

export function eventCursor(host: StoreHost, sequence: number): string {
  return `${host.epoch}:${sequence}`;
}

export function parseCursor(host: StoreHost, cursor: string): number {
  const [epoch, offset, extra] = cursor.split(":");
  const sequence = Number(offset);
  if (
    epoch !== host.epoch ||
    extra !== undefined ||
    !/^(0|[1-9]\d*)$/.test(offset ?? "") ||
    !Number.isSafeInteger(sequence)
  )
    throw new ControllerError(
      "resnapshot_required",
      "Cursor cannot be replayed; fetch a snapshot",
    );
  return sequence;
}
