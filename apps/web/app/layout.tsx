import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Serif, Inter } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const serif = IBM_Plex_Serif({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-ibm-plex-serif",
});

export const metadata: Metadata = {
  title: "Lloyd — Commercial underwriting workstation",
  description: "Privacy-preserving commercial property investigation and triage.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body className={`${sans.className} antialiased`}>
        <AppShell>
          {process.env.LLOYD_HOSTED_DEMO === "true" && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              Synthetic demo · Sample data only. This shared demo workspace and its conversations may reset. Please don’t enter real submissions or personal information.
            </div>
          )}
          {children}
        </AppShell>
      </body>
    </html>
  );
}
