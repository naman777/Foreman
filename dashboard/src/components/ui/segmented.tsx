import * as React from 'react'

import { cn } from '@/lib/utils'

type Option<T extends string> = {
  value: T
  label: React.ReactNode
  /** Needed when the label is only an icon. */
  'aria-label'?: string
}

/**
 * The grid/list switch from chaicode.com's udemy toolbar, also used for
 * difficulty and subject filters. The active segment is the one place a
 * warm brown fill is allowed: orange-100 on light, orange-900/40 on dark.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly Option<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the group for screen readers. */
  label: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="segmented"
      className={cn(
        'flex max-w-full overflow-x-auto rounded-md border border-gray-200 bg-white [scrollbar-width:none] dark:border-gray-800 dark:bg-black/50',
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          aria-label={o['aria-label']}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-9 min-w-9 shrink-0 cursor-pointer items-center justify-center gap-2 px-3.5 text-[13px] whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset [&_svg:not([class*='size-'])]:size-4",
            value === o.value
              ? 'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-100'
              : 'text-gray-600 hover:bg-orange-50 hover:text-orange-900 dark:text-gray-400 dark:hover:bg-orange-900/20 dark:hover:text-orange-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export { Segmented }
