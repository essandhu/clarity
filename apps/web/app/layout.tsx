import type { Metadata } from "next";
import localFont from "next/font/local";
import { AppNav } from "@/components/AppNav";
import "./globals.css";

// Self-hosted, offline-safe (next/font/local serves from our own origin — zero
// runtime/build-time external requests, honoring the local-first posture).
// Variable woff2, so no `weight` is pinned (that would collapse the axis).
const sans = localFont({
  src: "./fonts/InterVariable.woff2",
  variable: "--font-sans",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Clarity",
  description:
    "Turn a job listing into an interview-ready briefing with cited outreach hooks — local-first and free.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        {/* No-FOUC: a blocking inline script applies the persisted light theme
            before first paint. Dark (no data-theme) is the default. Must stay a
            raw inline <script> — a deferred/next/script would flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("clarity-theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}`,
          }}
        />
        <AppNav />
        {children}
      </body>
    </html>
  );
}
