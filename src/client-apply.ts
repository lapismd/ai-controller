import type { ControllerEvent, Snapshot } from "./contracts.js";
import type { ClientHost, Subscription } from "./client-host.js";
import { cursorAfter, reduceSnapshot } from "./client-snapshot.js";

export function applySubscriptionEvent(
  host: ClientHost,
  subscription: Subscription,
  event: ControllerEvent,
): void {
  if (
    !subscription.snapshot ||
    !cursorAfter(event.cursor, subscription.snapshot.cursor)
  )
    return;
  subscription.snapshot = reduceSnapshot(subscription.snapshot, event);
  for (const listener of subscription.listeners)
    notifySubscription(host, subscription, listener, event);
}

export function notifySubscription(
  host: ClientHost,
  subscription: Subscription,
  listener: (snapshot: Snapshot, event?: ControllerEvent) => void,
  event?: ControllerEvent,
): void {
  try {
    listener(structuredClone(subscription.snapshot!), event);
  } catch (error) {
    host.options.onError?.(
      error instanceof Error
        ? error
        : new Error("Subscription observer failed"),
    );
  }
}
