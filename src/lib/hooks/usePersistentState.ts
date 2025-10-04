import { useEffect, useRef, useState } from "react";

type StateUpdater<T> = T | ((current: T) => T);

export function usePersistentState<T>(key: string, initial: T): [T, (value: StateUpdater<T>) => void, () => void] {
  const isFirst = useRef(true);
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return { ...initial, ...parsed };
      }
      return parsed;
    } catch (error) {
      console.warn(`Failed to parse localStorage for ${key}`, error);
      return initial;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.warn(`Failed to persist ${key}`, error);
    }
  }, [state, key]);

  const updateState = (value: StateUpdater<T>) => {
    setState((current) => (typeof value === "function" ? (value as (c: T) => T)(current) : value));
  };

  const reset = () => setState(initial);

  return [state, updateState, reset];
}
