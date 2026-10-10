import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Backdrop } from "@/components/backdrop";
import { SiteFooter, SiteNav } from "@/components/SiteNav";
import { ThemeScript } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "Foreman: job scheduler",
  description: "Distributed job scheduler dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark h-full" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full">
        <Providers>
          <div className="flex min-h-screen flex-col">
            <Backdrop />
            <SiteNav />
            <main className="mx-auto w-full max-w-6xl flex-1 p-6 sm:p-12">
              {children}
            </main>
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  );
}
