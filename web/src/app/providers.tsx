import { QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, StrictMode } from 'react'
import { queryClient } from '../lib/api.ts'
export function Providers({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </StrictMode>
  )
}
