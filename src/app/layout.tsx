import type { Metadata } from "next";
import { JetBrains_Mono, Manrope } from "next/font/google";
import { Nav } from "../components/Nav";
import "./globals.css";

const sans = Manrope({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Inference Console",
  description: "Manage API keys and inspect inference requests, usage, cost, and latency.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">Inference Console</div>
            <Nav />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
