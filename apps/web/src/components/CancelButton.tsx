// Visible only while phase === 'running' (PLAN.md §6): aborts the in-flight
// run; the reducer's local `aborted` action closes open steps.

export function CancelButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button type="button" className="cancel-button" onClick={onCancel}>
      Cancel run
    </button>
  );
}
