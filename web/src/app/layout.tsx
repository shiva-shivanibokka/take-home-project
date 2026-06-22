import type { Metadata } from "next";
import { DM_Sans, Spectral, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const dm = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm",
  weight: ["300", "400", "500", "600", "700"],
});

const spectral = Spectral({
  subsets: ["latin"],
  variable: "--font-spectral",
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Research Desk — Multi-Agent Pipeline",
  description: "Live pipeline: Collector → Writer → Reviewer → Publish/Escalate",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dm.variable} ${spectral.variable} ${mono.variable}`}>
      <body style={{ fontFamily: "var(--font-dm, 'DM Sans', sans-serif)" }}>
        {children}
      </body>
    </html>
  );
}
