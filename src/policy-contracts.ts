export type NativePermissionMode = {
  requested: string;
  status: "applied" | "unsupported" | "rejected" | "unreported";
  effective?: string;
};

export type ExecutionPolicy = {
  requested: "ask" | "allow-all";
  effective: "ask" | "allow-all";
  restricted: boolean;
  nativeMode?: NativePermissionMode;
};
