import { Component, type ReactNode } from 'react'
import { ErrorNotice } from './DataState.tsx'
// A render error shows a message instead of a blank page (R46). Keyed by page, so moving to another
// page clears it.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <ErrorNotice
        label="This page crashed"
        error={this.state.error}
        onRetry={() => location.reload()}
        retryLabel="Reload"
      />
    )
  }
}
