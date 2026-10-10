"use client";

import { Hexagon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Navbar } from "@/components/navbar";

const NAV = [
  { href: "/playground", label: "Try it live" },
  { href: "/", label: "Overview" },
  { href: "/jobs", label: "Jobs" },
  { href: "/workers", label: "Workers" },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <Navbar
      layout="inline"
      logo={
        <Link href="/" aria-label="Foreman home" className="flex items-center gap-2 font-onest text-xl font-medium tracking-tight">
          <Hexagon className="size-5 text-brand" aria-hidden="true" />
          Foreman
        </Link>
      }
      groups={NAV.map((n) => ({
        ...n,
        active: n.href === "/" ? pathname === "/" : pathname.startsWith(n.href),
      }))}
    />
  );
}

export function SiteFooter() {
  return (
    <footer className="relative px-6 py-8 font-montserrat text-sm text-muted-foreground before:absolute before:top-0 before:left-1/2 before:h-px before:w-full before:max-w-[1440px] before:-translate-x-1/2 before:bg-amber-600 before:opacity-10 before:[mask-image:linear-gradient(90deg,transparent_0%,black_40%,black_60%,transparent_100%)] sm:px-12 dark:before:bg-orange-300">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>Foreman, a distributed job scheduler.</p>
        <p>Public live demo. TypeScript coordinator and workers.</p>
      </div>
    </footer>
  );
}
