import { type ReactNode, useEffect, useRef } from 'react'
import { Dialog as AriaDialog, Modal, ModalOverlay } from 'react-aria-components'
import { Button } from './Button.tsx'
import { Icon } from './Icon.tsx'

export function Dialog({
  title,
  children,
  isOpen,
  onOpenChange,
  busy = false,
}: {
  title: string
  children: ReactNode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  busy?: boolean
}) {
  const dialog = useRef<HTMLElement>(null)
  // Disabling the focused submit control can move focus to body. Recover inside the
  // dialog when the request settles so keyboard dismissal/navigation still work.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!busy && dialog.current && !dialog.current.contains(document.activeElement))
        dialog.current.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [busy])
  return (
    <ModalOverlay
      className="dialog-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
    >
      <Modal className="dialog-modal">
        <AriaDialog ref={dialog} className="dialog" aria-label={title}>
          <div className="dialog-heading">
            <h2>{title}</h2>
            <Button
              variant="secondary"
              aria-label="Close dialog"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              <Icon name="close" />
            </Button>
          </div>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  )
}
