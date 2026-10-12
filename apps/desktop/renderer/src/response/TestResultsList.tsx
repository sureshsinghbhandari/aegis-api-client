import type { TestResult } from '@aegis/core';
import { Badge, formatMs } from '../components/ui';

export function summarizeTests(tests: readonly TestResult[]): { passed: number; failed: number; skipped: number; total: number } {
  const skipped = tests.filter((t) => t.skipped).length;
  const passed = tests.filter((t) => t.passed && !t.skipped).length;
  return { passed, failed: tests.length - passed - skipped, skipped, total: tests.length };
}

export function TestSummary({ tests }: { tests: readonly TestResult[] }) {
  const s = summarizeTests(tests);
  const counted = s.total - s.skipped;
  return (
    <span className="tr-summary">
      <Badge tone={s.failed > 0 ? 'danger' : counted > 0 ? 'success' : 'neutral'}>
        {s.passed}/{counted} passed
      </Badge>
      {s.skipped > 0 && <span className="wb-dim">{s.skipped} skipped</span>}
    </span>
  );
}

export function TestResultsList({ tests, showSummary = true }: { tests: readonly TestResult[]; showSummary?: boolean }) {
  if (tests.length === 0) return <div className="empty">No tests were run. Add <code>pm.test(...)</code> calls in the Post-response tab of the request.</div>;
  return (
    <div className="tr-list">
      {showSummary && (
        <div className="tr-head">
          <TestSummary tests={tests} />
        </div>
      )}
      <ul className="tr-items" aria-label="Test results">
        {tests.map((t, i) => (
          <li key={i} className={`tr-item ${t.skipped ? 'skipped' : t.passed ? 'pass' : 'fail'}`}>
            <span className={`tr-badge ${t.skipped ? 'skipped' : t.passed ? 'pass' : 'fail'}`}>{t.skipped ? 'SKIP' : t.passed ? 'PASS' : 'FAIL'}</span>
            <div className="tr-main">
              <div className="tr-name">{t.name}</div>
              {t.error && <pre className="tr-error mono pre-wrap">{t.error}</pre>}
              {t.origin && <div className="wb-dim">{t.origin}</div>}
            </div>
            <span className="wb-dim">{formatMs(t.durationMs)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
