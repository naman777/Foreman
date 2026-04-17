"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clearToken } from "@/lib/api";
import { useRouter } from "next/navigation";

const NAV = [
    {
        href: "/",
        label: "Overview",
        icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
        ),
    },
    {
        href: "/jobs",
        label: "Jobs",
        icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                <path d="M9 14l2 2 4-4" />
            </svg>
        ),
    },
    {
        href: "/workers",
        label: "Workers",
        icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
                <path d="M6 6V4M18 6V4" />
            </svg>
        ),
    },
];

export function Sidebar() {
    const pathname = usePathname();
    const router = useRouter();

    // Don't render sidebar on login page
    if (pathname === "/login") return null;

    function handleLogout() {
        clearToken();
        router.replace("/login");
    }

    return (
        <aside className="fixed left-0 top-0 bottom-0 w-[260px] z-40 flex flex-col"
            style={{
                background: "rgba(10, 14, 26, 0.85)",
                backdropFilter: "blur(24px)",
                borderRight: "1px solid rgba(255, 255, 255, 0.06)",
            }}
        >
            {/* Brand */}
            <div className="px-6 pt-7 pb-6">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                        style={{ background: "var(--accent-gradient)" }}
                    >
                        ⚙
                    </div>
                    <div>
                        <h1 className="text-base font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
                            Foreman
                        </h1>
                        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>Job Scheduler</p>
                    </div>
                </div>
            </div>

            {/* Divider */}
            <div className="mx-5 h-px" style={{ background: "var(--border-subtle)" }} />

            {/* Navigation */}
            <nav className="flex-1 px-4 pt-5 space-y-1">
                <p className="px-3 mb-3 text-[10px] font-semibold uppercase tracking-[0.1em]"
                    style={{ color: "var(--text-muted)" }}
                >
                    Navigation
                </p>
                {NAV.map((n) => {
                    const isActive = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
                    return (
                        <Link
                            key={n.href}
                            href={n.href}
                            className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200"
                            style={{
                                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                                background: isActive ? "rgba(99, 102, 241, 0.1)" : "transparent",
                                borderLeft: isActive ? "2px solid var(--accent-primary)" : "2px solid transparent",
                            }}
                        >
                            <span
                                className="transition-colors duration-200"
                                style={{ color: isActive ? "var(--accent-primary)" : "var(--text-muted)" }}
                            >
                                {n.icon}
                            </span>
                            {n.label}
                            {isActive && (
                                <span
                                    className="ml-auto w-1.5 h-1.5 rounded-full"
                                    style={{ background: "var(--accent-primary)", boxShadow: "0 0 8px rgba(99, 102, 241, 0.5)" }}
                                />
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* Bottom section */}
            <div className="px-4 pb-6 space-y-2">
                <div className="mx-1 h-px mb-3" style={{ background: "var(--border-subtle)" }} />
                <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 cursor-pointer"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.color = "#ef4444";
                        e.currentTarget.style.background = "rgba(239, 68, 68, 0.08)";
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-muted)";
                        e.currentTarget.style.background = "transparent";
                    }}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Sign out
                </button>
            </div>
        </aside>
    );
}
