'use client'

import { createContext, use, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

type Theme = 'dark' | 'light'

type ThemeState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}

const STORAGE_KEY = 'chaiui-theme'

const ThemeContext = createContext<ThemeState | null>(null)

// The choice made in this tab, for when storage refuses to keep it.
let chosen: Theme | null = null
const listeners = new Set<() => void>()

function subscribe(onChange: () => void) {
  // Another tab changed the theme: its stored choice wins over this tab's.
  const onStorage = () => {
    chosen = null
    onChange()
  }
  listeners.add(onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function readStored(storageKey: string, fallback: Theme): Theme {
  if (typeof window === 'undefined') return fallback
  if (chosen) return chosen
  try {
    const v = localStorage.getItem(storageKey)
    return v === 'light' || v === 'dark' ? v : fallback
  } catch {
    return fallback
  }
}

/**
 * Dark by default, as on chaicode.com. The choice is a `dark` class on
 * <html>, kept in localStorage.
 */
export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  storageKey = STORAGE_KEY,
}: {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}) {
  // The server cannot see localStorage, so it renders the default and the
  // stored choice is read on the client. ThemeScript has already set the
  // class, so nothing flashes in between.
  const theme = useSyncExternalStore(
    subscribe,
    () => readStored(storageKey, defaultTheme),
    () => defaultTheme,
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
  }, [theme])

  const setTheme = useCallback(
    (next: Theme) => {
      try {
        localStorage.setItem(storageKey, next)
      } catch {
        // Private windows can refuse storage; the theme still applies.
      }
      chosen = next
      listeners.forEach((notify) => notify())
    },
    [storageKey],
  )

  const value = useMemo(
    () => ({ theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') }),
    [theme, setTheme],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme() {
  const ctx = use(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

/**
 * Sets the class before first paint. Put it in <head> (Next.js: in the root
 * layout, with `suppressHydrationWarning` on <html>). In a Vite app, the same
 * script can go straight into index.html.
 */
export function ThemeScript({ defaultTheme = 'dark', storageKey = STORAGE_KEY }: { defaultTheme?: Theme; storageKey?: string }) {
  const code = `(function(){try{var t=localStorage.getItem(${JSON.stringify(storageKey)});if(t!=='light'&&t!=='dark')t=${JSON.stringify(defaultTheme)};document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.colorScheme=t}catch(e){}})()`
  return <script dangerouslySetInnerHTML={{ __html: code }} />
}
