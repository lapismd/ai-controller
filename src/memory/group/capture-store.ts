import { CaptureBoundary } from "../../capture/boundary.js";
import { ControllerError } from "../../contracts.js";
import type { MemoryStorePort } from "./store-port.js";

/** Consumer authorization stays outside this generic first-write/read gate. */
export function capturedMemoryStore(store: MemoryStorePort, boundary: Pick<CaptureBoundary, "clean">): MemoryStorePort {
  const clean = (value: unknown): unknown => value === undefined ? undefined : boundary.clean(value);
  return new Proxy(store, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        if (property === "putEvidence") {
          const event = (args[0] as { event?: { sig?: string } })?.event;
          if (event?.sig) throw new ControllerError("evidence_projection_required", "Verified evidence must be projected by its owner before storage");
        }
        // All store ports are synchronous plain DTO APIs. Scanner rejection
        // happens before the consuming database sees any argument.
        return clean(Reflect.apply(method, target, args.map(clean)));
      };
    },
  });
}
