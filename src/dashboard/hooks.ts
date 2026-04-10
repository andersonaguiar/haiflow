import { useState, useEffect, useCallback, useRef } from "react";

/** Polls `fn` on an interval. Calls immediately, then every `ms`. */
export function usePolling(fn: () => void | Promise<void>, ms: number, deps: unknown[] = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    fnRef.current();
    const id = setInterval(() => fnRef.current(), ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

/** Hash-based routing. Returns [hash, setHash]. */
export function useHash(): [string, (h: string) => void] {
  const [hash, setHashState] = useState(() => location.hash.replace(/^#/, ""));

  useEffect(() => {
    const onHash = () => setHashState(location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setHash = useCallback((h: string) => {
    location.hash = h ? `#${h}` : "";
    setHashState(h);
  }, []);

  return [hash, setHash];
}

/** Global keyboard shortcuts. Ignores events inside input/textarea/select. */
export function useKeyboard(shortcuts: Record<string, () => void>) {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
