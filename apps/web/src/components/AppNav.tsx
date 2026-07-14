"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

// The global app shell (sticky top bar): brand wordmark, the two workflow nav
// pills with aria-current on the active route, and the theme toggle. This
// consolidates the branding that used to be duplicated inside AnalyzeView and
// ResumeView. usePathname is client-only, so this is a client component and
// layout.tsx stays a server component.

const NAV = [
  { href: "/", label: "Analyze" },
  { href: "/resume", label: "Resume" },
] as const;

export function AppNav() {
  const pathname = usePathname();
  return (
    <header className="app-shell">
      <nav className="site-nav" aria-label="Site">
        <Link href="/" className="wordmark">
          Clarity
        </Link>
        <div className="nav-pills">
          {NAV.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={active ? "nav-pill active" : "nav-pill"}
                aria-current={active ? "page" : undefined}
              >
                {label}
              </Link>
            );
          })}
        </div>
        <ThemeToggle />
      </nav>
    </header>
  );
}
