import { useMemo, type ChangeEvent } from 'react';
import type { CockpitModelEntry, CockpitModelSelection } from '@/lib/api';

interface ModelSwitcherProps {
  catalog: CockpitModelEntry[];
  selection: CockpitModelSelection | null;
  loading: boolean;
  onChange: (provider: string, model: string) => void;
}

export function ModelSwitcher({
  catalog,
  selection,
  loading,
  onChange,
}: ModelSwitcherProps) {
  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, CockpitModelEntry[]>();
    for (const model of catalog) {
      const models = grouped.get(model.provider) ?? [];
      models.push(model);
      grouped.set(model.provider, models);
    }
    return grouped;
  }, [catalog]);

  const selectedValue = selection ? `${selection.provider}:${selection.model}` : '';

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!value) return;
    const [provider, ...rest] = value.split(':');
    const model = rest.join(':');
    if (provider && model) {
      onChange(provider, model);
    }
  };

  return (
    <div className="ml-auto flex items-center gap-1.5 min-w-0">
      <label className="text-[9px] uppercase tracking-wide text-[var(--text-muted)] shrink-0">
        Model
      </label>
      <select
        value={selectedValue}
        onChange={handleChange}
        disabled={loading}
        className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] disabled:opacity-50 max-w-[220px] truncate"
        aria-label="Session model"
      >
        <option value="">Default</option>
        {[...modelsByProvider.entries()].map(([provider, models]) => (
          <optgroup key={provider} label={provider}>
            {models.map((model) => (
              <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
                {model.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
