import { Component, lazy, Suspense, useMemo, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';

interface RecoveryProps { onReload: () => void; onDownload: () => void; canDownload: boolean; busy: boolean }
interface BoundaryProps extends RecoveryProps { label: string; children: ReactNode }

class PanelBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="panel deferred-panel-error" role="alert"><strong>{this.props.label} could not be opened</strong><p>The rest of the editor is still available. Reload first saves pending edits. If saving fails, download the project and use save recovery.</p><button type="button" className="secondary-button" disabled={this.props.busy} onClick={this.props.onReload}>Reload editor</button>{this.props.canDownload && <button type="button" className="text-button" onClick={this.props.onDownload}>Download project</button>}</div>;
  }
}

interface Props<P> extends RecoveryProps {
  label: string;
  load: () => Promise<{ default: ComponentType<P> }>;
  fallback: ReactNode;
  children: (Panel: LazyExoticComponent<ComponentType<P>>) => ReactNode;
}

/** A failed optional chunk never takes the editor or its in-memory draft down. */
export function DeferredPanel<P>({ label, load, fallback, children, onReload, onDownload, canDownload, busy }: Readonly<Props<P>>) {
  const Panel = useMemo(() => lazy(load), [load]);
  // Browsers retain failed module imports. Do not offer a retry that reuses the
  // same rejected module; App guards a deliberate page reload with autosave.
  return <PanelBoundary label={label} onReload={onReload} onDownload={onDownload} canDownload={canDownload} busy={busy}><Suspense fallback={fallback}>{children(Panel)}</Suspense></PanelBoundary>;
}