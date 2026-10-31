import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a callback whose identity never changes but which always runs the
 * latest committed closure, so memoized per-cue children can skip rendering
 * without ever observing stale workbench state.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
