import type { ControllerEvent, Snapshot } from "./contracts.js";
import { applySubscriptionEvent, notifySubscription } from "./client-apply.js";
import type { ClientHost, Subscription } from "./client-host.js";
import { cursorAfter } from "./client-snapshot.js";
import { sendRequest } from "./client-transport.js";

export async function subscribeJournal(
  host: ClientHost,
  connect: () => Promise<void>,
  subscribe: (
    threadId: string,
    listener: (snapshot: Snapshot, event?: ControllerEvent) => void,
  ) => Promise<() => void>,
  threadId: string,
  options: {
    after?: string;
    afterSequence?: number;
    onError?(error: unknown): void;
  },
  listener: (event: ControllerEvent) => void | Promise<void>,
): Promise<() => void> {
  let cursor = options.after;
  let target: string | undefined;
  let stopped = false;
  let pumping = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    if (pumping || stopped || retry || !target) return;
    pumping = true;
    void (async () => {
      cursor ??= `${target!.split(":")[0]}:${options.afterSequence ?? 0}`;
      while (!stopped && cursorAfter(target!, cursor!)) {
        const barrier = target!;
        const page: ControllerEvent[] = (await sendRequest(host, "events.read", {
          threadId,
          after: cursor,
          limit: 1000,
        })) as ControllerEvent[];
        for (const event of page) {
          if (stopped || cursorAfter(event.cursor, barrier)) break;
          if (!cursorAfter(event.cursor, cursor!)) continue;
          await listener(event);
          cursor = event.cursor;
        }
        if (
          !page.length ||
          (page.length < 1000 && !cursorAfter(page.at(-1)!.cursor, barrier))
        )
          cursor = barrier;
      }
    })()
      .catch((error) => {
        options.onError?.(error);
        if (!stopped)
          retry = setTimeout(() => {
            retry = undefined;
            pump();
          }, 1000);
      })
      .finally(() => {
        pumping = false;
      });
  };
  void connect;
  const unsubscribe = await subscribe(threadId, (snapshot) => {
    target = snapshot.cursor;
    pump();
  });
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    unsubscribe();
  };
}

export async function subscribeThread(
  host: ClientHost,
  connect: () => Promise<void>,
  threadId: string,
  listener: (snapshot: Snapshot, event?: ControllerEvent) => void,
): Promise<() => void> {
  let subscription = host.subscriptions.get(threadId);
  if (!subscription) {
    subscription = { buffered: [], initializing: true, listeners: new Set() };
    host.subscriptions.set(threadId, subscription);
  }
  subscription.listeners.add(listener);
  await connect();
  if (!subscription.snapshot || subscription.initializing)
    await synchronizeSubscription(host, threadId, subscription);
  else notifySubscription(host, subscription, listener);
  return () => {
    subscription!.listeners.delete(listener);
    if (!subscription!.listeners.size) {
      host.subscriptions.delete(threadId);
      if (!host.disposed)
        void sendRequest(host, "events.unsubscribe", { threadId }).catch(
          () => {},
        );
    }
  };
}

export function synchronizeSubscription(
  host: ClientHost,
  threadId: string,
  subscription: Subscription,
): Promise<void> {
  if (subscription.synchronizing) return subscription.synchronizing;
  subscription.synchronizing = synchronizeOnce(host, threadId, subscription).finally(
    () => {
      subscription.synchronizing = undefined;
    },
  );
  return subscription.synchronizing;
}

async function synchronizeOnce(
  host: ClientHost,
  threadId: string,
  subscription: Subscription,
): Promise<void> {
  subscription.initializing = true;
  subscription.buffered = [];
  const result = (await sendRequest(host, "events.subscribe", { threadId })) as {
    snapshot: Snapshot;
  };
  if (host.subscriptions.get(threadId) !== subscription) return;
  subscription.snapshot = result.snapshot;
  subscription.initializing = false;
  for (const event of subscription.buffered.splice(0))
    applySubscriptionEvent(host, subscription, event);
  for (const listener of subscription.listeners)
    notifySubscription(host, subscription, listener);
}
