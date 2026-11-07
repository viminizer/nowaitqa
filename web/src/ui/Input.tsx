import type { ComponentPropsWithoutRef } from 'react'
export function Input(props: Omit<ComponentPropsWithoutRef<'input'>, 'style' | 'className'>) {
  return <input className="input" {...props} />
}
