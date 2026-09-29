import React from "react";

interface BoundaryState { error: Error | null }
interface BoundaryProps extends React.PropsWithChildren {
  onOpenSettings?: () => void;
  onError?: (error: Error) => void;
  recovery?: React.ReactNode;
}

export class ErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  public state: BoundaryState = { error: null };

  public static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  public componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  public render() {
    if (this.state.error === null) return this.props.children;
    const reload = (settings: boolean) => {
      if (!window.confirm("Reload the app? Progress not saved to a slot may be lost. Existing saves will not be erased.")) return;
      if (settings) window.location.hash = "#settings";
      window.location.reload();
    };
    const fallback = <div className="panel border-rose-600/70" role="alert">
        <h1 className="heading text-rose-200">The interface encountered an error</h1>
        <p className="mt-2 text-sm text-slate-300">
          The game has not been reset or overwritten. Use the recovery controls below to inspect slots, load a backup, or start a new game only after confirmation.
        </p>
        <p className="mt-2 break-words text-xs text-rose-300">{this.state.error.message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="button" type="button" onClick={() => reload(false)}>Reload app</button>
          {this.props.onOpenSettings
            ? <button className="button selected" type="button" onClick={this.props.onOpenSettings}>
              Open Settings & saves without reloading
            </button>
            : <button className="button selected" type="button" onClick={() => reload(true)}>
              Reload into Settings
            </button>}
        </div>
      </div>;
    return this.props.onOpenSettings
      ? <section aria-label="Dashboard recovery" className="py-3 text-slate-100">
        {fallback}
        {this.props.recovery && <div className="mt-5">{this.props.recovery}</div>}
      </section>
      : <main className="mx-auto max-w-2xl p-6 text-slate-100">
        {fallback}
        {this.props.recovery && <div className="mt-5">{this.props.recovery}</div>}
      </main>;
  }
}
