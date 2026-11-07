import type { ComponentPropsWithoutRef } from 'react'
export function Form({
  layout = 'default',
  ...props
}: Omit<ComponentPropsWithoutRef<'form'>, 'style' | 'className'> & {
  layout?: 'default' | 'two-column'
}) {
  return <form className="action-form" data-layout={layout} {...props} />
}
