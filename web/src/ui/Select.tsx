import {
  Select as AriaSelect,
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
} from 'react-aria-components'

// React Aria owns keyboard/focus behavior and a hidden native field for form submission.
// Pages use this wrapper; visible native selects and direct headless imports are disallowed.
export function Select({
  id,
  name,
  label,
  options,
  defaultValue,
  value,
  onValueChange,
  disabled,
  required,
  'aria-describedby': describedBy,
}: {
  id: string
  name: string
  label: string
  options: readonly { value: string; label: string }[]
  value?: string
  onValueChange?: (value: string) => void
  defaultValue?: string
  disabled?: boolean
  required?: boolean
  'aria-describedby'?: string
}) {
  return (
    <AriaSelect
      className="select"
      name={name}
      aria-label={label}
      aria-describedby={describedBy}
      defaultSelectedKey={defaultValue}
      selectedKey={value}
      onSelectionChange={(key) => onValueChange?.(String(key))}
      isDisabled={disabled}
      isRequired={required}
    >
      <Button id={id} className="select-trigger">
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </Button>
      <Popover className="select-popover" data-appearance="compact">
        <ListBox className="select-options" items={options}>
          {(option) => (
            <ListBoxItem id={option.value} textValue={option.label} className="select-option">
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  )
}
