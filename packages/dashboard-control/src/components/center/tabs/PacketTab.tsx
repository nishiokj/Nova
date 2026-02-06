import { useMemo } from 'react';
import { useCockpit, selectActivePacket, selectParsedPacket } from '@/hooks/use-cockpit-store';
import { parseInlineRefs, PACKET_REF_REGEX } from '@/lib/packets';

function InlineRefs({
  text,
  onRefClick,
  isRefResolved,
}: {
  text: string;
  onRefClick: (refType: string, target: string) => void;
  isRefResolved: (refType: string, target: string) => boolean;
}) {
  const segments = parseInlineRefs(text, isRefResolved);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <button
            key={i}
            onClick={() => seg.resolved && onRefClick(seg.refType!, seg.target!)}
            disabled={!seg.resolved}
            title={seg.resolved ? `Open ${seg.value}` : `Unresolved ${seg.value}`}
            className={`underline ${
              seg.resolved
                ? 'text-[var(--accent-cyan)] hover:text-[var(--running)]'
                : 'text-[var(--error)] decoration-wavy cursor-not-allowed opacity-80'
            }`}
          >
            {seg.value}
          </button>
        )
      )}
    </>
  );
}

function PacketBody({
  markdown,
  onRefClick,
  isRefResolved,
}: {
  markdown: string;
  onRefClick: (refType: string, target: string) => void;
  isRefResolved: (refType: string, target: string) => boolean;
}) {
  const lines = markdown.split('\n');
  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trimEnd();
        if (!line.trim()) return <div key={idx} className="h-2" />;
        if (line.startsWith('### '))
          return <h3 key={idx} className="text-sm font-semibold text-[var(--text-primary)] mt-2"><InlineRefs text={line.slice(4)} onRefClick={onRefClick} isRefResolved={isRefResolved} /></h3>;
        if (line.startsWith('## '))
          return <h2 key={idx} className="text-base font-semibold text-[var(--text-primary)] mt-2"><InlineRefs text={line.slice(3)} onRefClick={onRefClick} isRefResolved={isRefResolved} /></h2>;
        if (line.startsWith('# '))
          return <h1 key={idx} className="text-lg font-semibold text-[var(--text-primary)] mb-1"><InlineRefs text={line.slice(2)} onRefClick={onRefClick} isRefResolved={isRefResolved} /></h1>;
        const numbered = line.match(/^(\d+)\.\s+(.*)$/);
        if (numbered) {
          return (
            <div key={idx} className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] shrink-0">{numbered[1]}.</span>
              <span><InlineRefs text={numbered[2]} onRefClick={onRefClick} isRefResolved={isRefResolved} /></span>
            </div>
          );
        }
        if (line.startsWith('- ')) {
          return (
            <div key={idx} className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] shrink-0">-</span>
              <span><InlineRefs text={line.slice(2)} onRefClick={onRefClick} isRefResolved={isRefResolved} /></span>
            </div>
          );
        }
        return <p key={idx} className="text-[var(--text-secondary)]"><InlineRefs text={line} onRefClick={onRefClick} isRefResolved={isRefResolved} /></p>;
      })}
    </div>
  );
}

export function PacketTab() {
  const { state, set, resolvePacketRef, handlePacketRefClick, handlePacketLinkClick } = useCockpit();
  const activePacket = useMemo(() => selectActivePacket(state), [state.selectedPacketId, state.sessionPackets, state.focusData?.packet?.packetId]);
  const parsed = useMemo(() => selectParsedPacket(state), [activePacket?.contentMarkdown]);

  const evidence = useMemo(() => {
    if (!parsed.bodyMarkdown && !parsed.frontmatter) {
      return { summaryBullets: 0, evidenceBackedBullets: 0, totalRefs: 0, resolvedRefs: 0, brokenRefs: [] as string[] };
    }
    const lines = parsed.bodyMarkdown.split('\n');
    let summaryBullets = 0, evidenceBackedBullets = 0, totalRefs = 0, resolvedRefs = 0;
    const brokenRefs = new Set<string>();

    for (const ref of parsed.frontmatter?.refs ?? []) {
      totalRefs++;
      if (resolvePacketRef(ref.type, ref.target)) resolvedRefs++;
      else brokenRefs.add(`@${ref.type}(${ref.target})`);
    }
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
      let match: RegExpExecArray | null;
      const lineRefs: { resolved: boolean }[] = [];
      while ((match = regex.exec(line)) !== null) {
        const resolved = resolvePacketRef(match[1], match[2]);
        lineRefs.push({ resolved });
        totalRefs++;
        if (resolved) resolvedRefs++;
        else brokenRefs.add(`@${match[1]}(${match[2]})`);
      }
      if (line.startsWith('- ') || /^\d+\.\s+/.test(line)) {
        summaryBullets++;
        if (lineRefs.some((r) => r.resolved)) evidenceBackedBullets++;
      }
    }
    return { summaryBullets, evidenceBackedBullets, totalRefs, resolvedRefs, brokenRefs: Array.from(brokenRefs) };
  }, [parsed, resolvePacketRef]);

  if (!activePacket) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No packet loaded</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">Packets appear when the session emits structured output</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {state.sessionPackets.length > 1 && (
        <select
          value={state.selectedPacketId ?? activePacket.packetId}
          onChange={(e) => set({ selectedPacketId: e.target.value })}
          className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] text-[var(--text-secondary)]"
        >
          {state.sessionPackets.map((packet) => (
            <option key={packet.packetId} value={packet.packetId}>
              {packet.type} · {new Date(packet.createdAt).toLocaleTimeString()}
            </option>
          ))}
        </select>
      )}
      <div className="text-[11px] text-[var(--text-muted)]">
        Bullets {evidence.evidenceBackedBullets}/{evidence.summaryBullets || 0} backed
        {' · '}Refs {evidence.resolvedRefs}/{evidence.totalRefs || 0} resolved
      </div>

      {parsed.frontmatter && (
        <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-1">
            {parsed.frontmatter.type && (
              <span className="px-1.5 py-0.5 rounded bg-[var(--running)]/15 text-[var(--running)] uppercase">
                {parsed.frontmatter.type}
              </span>
            )}
            {parsed.frontmatter.requestedDecision && (
              <span className="px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] uppercase">
                decision: {parsed.frontmatter.requestedDecision}
              </span>
            )}
            {parsed.frontmatter.priority && (
              <span className="px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)] uppercase">
                priority: {parsed.frontmatter.priority}
              </span>
            )}
          </div>
          {parsed.frontmatter.links.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {parsed.frontmatter.links.map((link) => (
                <button
                  key={`${link.label}:${link.target}`}
                  onClick={() => void handlePacketLinkClick(link.target)}
                  className="px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/20"
                >
                  {link.label}
                </button>
              ))}
            </div>
          )}
          {parsed.frontmatter.refs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {parsed.frontmatter.refs.map((ref, idx) => {
                const resolved = resolvePacketRef(ref.type, ref.target);
                return (
                  <button
                    key={`${ref.type}:${ref.target}:${idx}`}
                    onClick={() => resolved && void handlePacketRefClick(ref.type, ref.target)}
                    disabled={!resolved}
                    className={`px-1.5 py-0.5 rounded ${
                      resolved
                        ? 'bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/20'
                        : 'bg-[var(--error)]/10 text-[var(--error)] cursor-not-allowed'
                    }`}
                  >
                    @{ref.type}({ref.target})
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {evidence.brokenRefs.length > 0 && (
        <div className="text-[11px] text-[var(--error)]">
          Broken refs: {evidence.brokenRefs.slice(0, 6).join(', ')}
        </div>
      )}

      <PacketBody
        markdown={parsed.bodyMarkdown}
        onRefClick={(r, t) => void handlePacketRefClick(r, t)}
        isRefResolved={resolvePacketRef}
      />
    </div>
  );
}
