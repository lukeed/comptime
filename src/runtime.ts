const RUNTIME_ERROR = "Missing comptime() plugin";
export function comptime<T>(_fn: () => Promise<T> | T): T {
  throw new Error(RUNTIME_ERROR);
}
