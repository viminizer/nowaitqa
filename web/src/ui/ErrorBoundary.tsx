import { Component, type ReactNode } from 'react'
import { Button } from './Button.tsx'
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
      <p className="error" role="alert">
        This page crashed: {this.state.error.message}{' '}
        <Button type="button" onClick={() => location.reload()}>
          Reload
        </Button>
      </p>
    )
  }
}
