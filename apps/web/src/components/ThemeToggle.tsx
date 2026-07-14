"use client";

import { useEffect, useState } from "react";

// Dark is the default identity; light is opt-in and persisted. The no-FOUC
// inline script in layout.tsx sets [data-theme="light"] before paint from
// localStorage — this button only flips it at runtime. State is read in an
// effect (never during render) with a `mounted` guard so the first client
// render matches SSR markup (the sessionStorage-handoff precedent) — no
// hydration mismatch on the button itself.

const STORAGE_KEY = "clarity-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Microtask-deferred: the lint rule forbids synchronous setState in an
    // effect body (the ResumeView handoff precedent).
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
      setMounted(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    if (next === "light") {
      document.documentElement.dataset.theme = "light";
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort; the toggle still works this session.
    }
    setTheme(next);
  };

  const isLight = mounted && theme === "light";
  const label = isLight ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <span aria-hidden="true">{isLight ? "☾" : "☀"}</span>
    </button>
  );
}
