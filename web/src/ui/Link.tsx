import type { ComponentPropsWithoutRef } from 'react'

// Navigating actions share the button contract; record references opt into inline text.
export function Link({
  variant = 'secondary',
  ...props
}: Omit<ComponentPropsWithoutRef<'a'>, 'style' | 'className'> & {
  href: string
  variant?: 'primary' | 'secondary' | 'inline'
}) {
  return (
    <a
      className={variant === 'inline' ? 'text-link' : 'button'}
      data-variant={variant}
      {...props}
    />
  )
}
