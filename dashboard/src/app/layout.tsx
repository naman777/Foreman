import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/Sidebar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Foreman — Job Scheduler",
  description: "Distributed job scheduler dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full antialiased">
        <Providers>
          <AuthGuard>
            <div className="flex min-h-screen">
              <Sidebar />
              <main className="flex-1 ml-[260px] relative z-[1]">
                <div className="max-w-[1400px] mx-auto px-6 py-8 lg:px-10">
                  {children}
                </div>
              </main>
            </div>
          </AuthGuard>
        </Providers>
      </body>
    </html>
  );
}
