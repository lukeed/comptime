const RUNTIME_ERROR =
  "comptime() must be replaced by the Vite or Rolldown plugin before runtime";

export function comptime<T>(_fn: () => T): T {
  throw new Error(RUNTIME_ERROR);
}
