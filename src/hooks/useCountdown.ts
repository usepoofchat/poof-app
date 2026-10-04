import { useEffect, useState } from "react";

export interface Countdown {
  /** Milliseconds left (never negative), or null when there is no deadline yet. */
  remainingMs: number | null;
  /** "mm:ss" up to 60:00, "h:mm:ss" above that (24 h super rooms). "--:--" without a deadline. */
  label: string;
}

/** Format milliseconds left as the countdown label. Rounds up, so "00:00" means really over. */
export function formatRemaining(ms: number | null): string {
  if (ms === null) return "--:--";
  const total = Math.max(0, Math.ceil(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const seconds = total % 60;
  // A 60-minute room starts at "60:00", not "1:00:00".
  if (total <= 3600) return `${two(Math.floor(total / 60))}:${two(seconds)}`;
  return `${Math.floor(total / 3600)}:${two(Math.floor((total % 3600) / 60))}:${two(seconds)}`;
}

/**
 * Countdown to `expiresAt` (Unix ms in the local clock domain, as SessionState provides it). Display
 * only: the room ends when the server says so (`status: "expired"`), not when this reaches zero.
 */
export function useCountdown(expiresAt: number | null, now: () => number = Date.now): Countdown {
  const [current, setCurrent] = useState(now);

  useEffect(() => {
    if (expiresAt === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const t = now();
      setCurrent(t);
      const left = expiresAt - t;
      if (left <= 0) return;
      // Wake up right after the next whole second so the label never skips or lingers.
      timer = setTimeout(tick, (left % 1000 || 1000) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [expiresAt, now]);

  const remainingMs = expiresAt === null ? null : Math.max(0, expiresAt - current);
  return { remainingMs, label: formatRemaining(remainingMs) };
}
