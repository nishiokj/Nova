import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import { formatRelativeFromIso } from '@/lib/format';

export function TestsTab() {
  const testReports = useCockpit(s => s.testReports);
  const selectedTestReportId = useCockpit(s => s.selectedTestReportId);
  const selectedTestReport = useCockpit(s => s.selectedTestReport);
  const store = useCockpitStore();

  if (testReports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No test reports</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">Test reports appear when the session runs test suites</div>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-1 xl:grid-cols-[16rem_minmax(0,1fr)] gap-3">
        <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
          {testReports.map((report) => (
            <button
              key={report.id}
              onClick={() => void store.handleSelectTestReport(report.id)}
              className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                selectedTestReportId === report.id ? 'bg-[var(--success)]/10' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[var(--text-secondary)]">{report.id.slice(0, 8)}</span>
                <span className="uppercase text-[10px] text-[var(--text-muted)]">{report.verdict}</span>
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">{formatRelativeFromIso(report.createdAt)}</div>
            </button>
          ))}
        </div>
        <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
          {selectedTestReport ? (
            <>
              <div className="text-[var(--text-primary)] font-medium">
                {selectedTestReport.command || 'Test Report'}
              </div>
              <div className="text-[var(--text-muted)]">
                Verdict {selectedTestReport.verdict} · Duration {selectedTestReport.durationMs}ms
              </div>
              <div className="space-y-1">
                {selectedTestReport.categories.map((cat, idx) => (
                  <div key={idx} className="text-[var(--text-secondary)]">
                    {String(cat.category ?? cat.name ?? 'category')}: {String(cat.verdict ?? 'unknown')}
                  </div>
                ))}
              </div>
              {selectedTestReport.agentNote && (
                <p className="text-[var(--text-secondary)] whitespace-pre-wrap">{selectedTestReport.agentNote}</p>
              )}
            </>
          ) : (
            <div className="text-[var(--text-muted)]">Select a report</div>
          )}
        </div>
      </div>
    </div>
  );
}
