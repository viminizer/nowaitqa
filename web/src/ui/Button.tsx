import type { ComponentPropsWithoutRef } from 'react'
export function Button({
  type = 'button',
  variant = 'secondary',
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'style' | 'className'> & {
  variant?: 'primary' | 'secondary'
}) {
  return <button className="button" type={type} data-variant={variant} {...props} />
}
