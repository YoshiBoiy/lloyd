import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-sans",
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
    <html lang="en">
      <body className={`${sans.variable} ${serif.variable} antialiased`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
