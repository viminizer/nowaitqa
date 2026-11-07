import type { ComponentPropsWithoutRef } from 'react'
export function Button({
  type = 'button',
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'style' | 'className'>) {
  return <button className="button" type={type} {...props} />
}
