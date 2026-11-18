import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one failed view from blanking the window: React drops the whole page on an uncaught error while drawing, so
 * each channel's tile, the main view and the window itself are wrapped. The failed part says so and can be drawn
 * again; everything else, and every CLI, keeps running. `resetKey` (the view shown) draws it again when it changes.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; resetKey?: unknown }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error(`${this.props.label} could not be shown.`, error, info.componentStack); }
  componentDidUpdate(previous: { resetKey?: unknown }) { if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="view-failed" role="alert">
      <strong>{this.props.label} could not be shown.</strong>
      <span>{this.state.error.message || 'An error occurred while drawing it.'} The rest of Trace keeps running.</span>
      <button type="button" className="quiet-button" onClick={() => this.setState({ error: null })}>Try again</button>
    </div>;
  }
}
