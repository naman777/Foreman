import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AuthGuard } from "@/components/AuthGuard";
import Link from "next/link";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Foreman — Job Scheduler",
  description: "Distributed job scheduler dashboard",
};

const NAV = [
  { href: "/",        label: "Overview" },
  { href: "/workers", label: "Workers"  },
  { href: "/jobs",    label: "Jobs"     },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full bg-zinc-50 text-zinc-900 antialiased">
        <nav className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
            <span className="font-semibold tracking-tight">⚙&nbsp;Foreman</span>
            <div className="flex gap-1">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
                >
                  {n.label}
                </Link>
              ))}
            </div>
          </div>
        </nav>
        <Providers>
          <AuthGuard>
            <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
              {children}
            </main>
          </AuthGuard>
        </Providers>
      </body>
    </html>
  );
}
