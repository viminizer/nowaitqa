import { formatDuration } from '@nowait/shared'
export const duration = (ms: number | null) => (ms === null ? '-' : formatDuration(ms))

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' })
export const time = (date: Date | string | null) =>
  date ? dateTime.format(typeof date === 'string' ? Date.parse(date) : date) : '-'
