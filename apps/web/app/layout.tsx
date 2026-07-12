import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clarity",
  description:
    "Turn a job listing into an interview-ready briefing with cited outreach hooks — local-first and free.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav className="site-nav" aria-label="Site">
          <Link href="/">Analyze</Link>
          <Link href="/resume">Resume</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
