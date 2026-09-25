import type { DatabaseSync } from "node:sqlite";
import type { CaptureBoundary } from "../capture/boundary.js";
import type {
  ControllerEvent,
  Interaction,
  Preparation,
  Turn,
} from "../contracts.js";

export type StoreHost = {
  db: DatabaseSync;
  capture: CaptureBoundary;
  epoch: string;
  volatileTurns: Map<string, Turn>;
  volatilePreparations: Map<string, Preparation>;
  volatileInteractions: Map<string, Interaction>;
  volatileEvents: Map<string, ControllerEvent>;
  listeners: Set<(event: ControllerEvent) => void>;
  pendingEvents?: ControllerEvent[];
  transaction<T>(operation: () => T): T;
};
