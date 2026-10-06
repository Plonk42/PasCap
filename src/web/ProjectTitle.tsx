import { useId, useState } from 'react';

export function ProjectTitle({
  title,
  projectId,
  disabled,
  onCommit,
}: Readonly<{ title: string; projectId: string | null; disabled: boolean; onCommit: (title: string) => void }>) {
  const errorId = useId();
  const [state, setState] = useState({ title, projectId, draft: title });
  const [error, setError] = useState('');
  if (state.title !== title || state.projectId !== projectId) {
    setState({ title, projectId, draft: title });
    setError('');
  }
  const commit = (): void => {
    if (disabled) return;
    const next = state.draft.trim();
    if (!next) {
      setError('Enter a project title. Escape restores the current title.');
      return;
    }
    setState({ title, projectId, draft: title });
    setError('');
    if (next !== title) onCommit(next);
  };
  return (
    <div className="project-title-field" data-dirty={state.draft !== title}>
      <input
        className="project-title"
        aria-label="Project title"
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        title={error || 'Rename project · Enter or leave the field to apply · Esc cancels'}
        maxLength={200}
        value={state.draft}
        disabled={disabled}
        onChange={(event) => {
          setState({ ...state, draft: event.target.value });
          setError('');
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setState({ title, projectId, draft: title });
            setError('');
          }
        }}
      />
      {error && (
        <span className="title-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
