import { useMemo, useState } from 'react';
import type { ImportSeverity, ImportWarningModel } from '@aegis/core';
import { Badge, Button } from '../../components/ui';
import { countWarnings, filterWarnings, sourceValueExcerpt } from '../../lib/import-helpers';
import { formatCount } from '../../lib/ui-format';
import '../../styles/panels.css';

const TONE: Record<ImportSeverity, 'danger' | 'warning' | 'info'> = { ERROR: 'danger', WARNING: 'warning', INFO: 'info' };
const PAGE = 100;

/** "Warnings: ERROR 0 WARNING 3 INFO 12" header plus an expandable, filterable list. */
export function WarningList({ warnings, defaultOpen = false }: { warnings: ImportWarningModel[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [severity, setSeverity] = useState<ImportSeverity | 'ALL'>('ALL');
  const [limit, setLimit] = useState(PAGE);
  const counts = useMemo(() => countWarnings(warnings), [warnings]);
  const shown = useMemo(() => filterWarnings(warnings, severity), [warnings, severity]);

  return (
    <div className="warn">
      <div className="warn-head">
        <strong>Warnings:</strong>
        <Badge tone={counts.ERROR ? 'danger' : 'neutral'}>ERROR {formatCount(counts.ERROR)}</Badge>
        <Badge tone={counts.WARNING ? 'warning' : 'neutral'}>WARNING {formatCount(counts.WARNING)}</Badge>
        <Badge tone={counts.INFO ? 'info' : 'neutral'}>INFO {formatCount(counts.INFO)}</Badge>
        {warnings.length > 0 && (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Show details'}
          </Button>
        )}
      </div>
      {warnings.length === 0 && <div className="field-hint">No warnings. Everything was understood.</div>}
      {open && warnings.length > 0 && (
        <>
          <div className="warn-filter">
            <label>
              <span className="field-label">Severity </span>
              <select
                value={severity}
                onChange={(e) => {
                  setSeverity(e.target.value as ImportSeverity | 'ALL');
                  setLimit(PAGE);
                }}
              >
                <option value="ALL">All ({formatCount(warnings.length)})</option>
                <option value="ERROR">Errors ({formatCount(counts.ERROR)})</option>
                <option value="WARNING">Warnings ({formatCount(counts.WARNING)})</option>
                <option value="INFO">Info ({formatCount(counts.INFO)})</option>
              </select>
            </label>
          </div>
          <ul className="warn-list" aria-label="Import warnings">
            {shown.slice(0, limit).map((w, i) => (
              <li key={i} className="warn-item">
                <Badge tone={TONE[w.severity]}>{w.severity}</Badge>
                <div className="warn-body">
                  <div className="warn-msg">{w.message}</div>
                  {w.path && <code className="warn-path">{w.path}</code>}
                  {w.sourceValue && <code className="warn-src">{sourceValueExcerpt(w)}</code>}
                </div>
              </li>
            ))}
          </ul>
          {shown.length > limit && (
            <Button size="sm" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({formatCount(shown.length - limit)} remaining)
            </Button>
          )}
        </>
      )}
    </div>
  );
}
