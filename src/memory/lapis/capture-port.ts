import { RedactionScope, type Result, type Json } from "@lapismd/agent-redaction";

export interface MemoryCapture {
  value(input: unknown): Promise<Result<Json>>;
}

function dto(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("memory_capture_invalid");
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("memory_capture_invalid");
    return dto(descriptor.value, depth + 1);
  });
  if (!value || typeof value !== "object") return value;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("memory_capture_invalid");
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error("memory_capture_invalid");
    if (descriptor.value !== undefined) output[key] = dto(descriptor.value, depth + 1);
  }
  return output;
}

/** Portable default reports portable coverage; native consumers inject their enforcement adapter. */
export class MemoryCaptureBoundary {
  constructor(readonly capture: MemoryCapture = new RedactionScope()) {}
  async clean<T>(input: T): Promise<T> {
    if (input === undefined) return input;
    if (input instanceof Set) return new Set(await this.clean([...input])) as T;
    const result = await this.capture.value(dto(input));
    if (result.status === "omitted") throw new Error("memory_capture_rejected");
    return result.value as T;
  }
  port<T extends object>(target: T, execution = false): T {
    return new Proxy(target, {
      get: (object, key) => {
        const method = Reflect.get(object, key);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          // Evidence read arguments remain the consumer's authorized capability.
          const effective = execution ? args : await Promise.all(args.map(value => this.clean(value)));
          const raw = await Reflect.apply(method, object, effective);
          const clean = await this.clean(raw);
          if (execution && raw && clean && typeof raw === "object") {
            const pairs = Array.isArray(raw) ? raw.map((item, index) => [item?.location, clean[index]?.location]) : [[raw.location, clean.location]];
            if (pairs.some(([before, after]) => JSON.stringify(before) !== JSON.stringify(after))) throw new Error("memory_capture_location_rejected");
          }
          return clean;
        };
      },
    });
  }
}
