import { useState } from 'react';
import type { ToolCallEntry } from '../store';

interface Props {
  toolCalls: ToolCallEntry[];
}

export function ToolCallCard({ toolCalls }: Props) {
  const running = toolCalls.filter((tc) => tc.status === 'running');
  const done = toolCalls.filter((tc) => tc.status !== 'running');

  return (
    <div className="tool-calls">
      {running.length > 0 && (
        <div className="tool-calls-group">
          {running.map((tc) => (
            <ToolCallItem key={tc.callId} tc={tc} />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="tool-calls-group">
          {done.map((tc) => (
            <ToolCallItem key={tc.callId} tc={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '(無參數)';
  if (entries.length <= 3) {
    const parts = entries.map(([k, v]) => {
      const val = typeof v === 'string' ? (v.length > 80 ? v.slice(0, 80) + '…' : v) : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    return parts.join(' · ');
  }
  return JSON.stringify(args, null, 2);
}

function ToolCallItem({ tc }: { tc: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = tc.status === 'running';
  const isError = tc.status === 'error';

  const statusIcon = isRunning ? (
    <span className="tool-call-spinner" />
  ) : isError ? (
    <span className="tool-call-status-icon tool-call-status-error">✕</span>
  ) : (
    <span className="tool-call-status-icon tool-call-status-ok">✓</span>
  );

  const briefArgs = !expanded ? formatArgs(tc.args) : '';

  return (
    <div className={`tool-call-card tool-call-${tc.status}`}>
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        {statusIcon}
        <span className="tool-call-name">{tc.tool}</span>
        {!expanded && briefArgs && (
          <span className="tool-call-brief">{briefArgs}</span>
        )}
        <span className="tool-call-expand">{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-label">參數</div>
            <pre>{JSON.stringify(tc.args, null, 2)}</pre>
          </div>
          {tc.result != null && (
            <div className="tool-call-section">
              <div className="tool-call-label">結果</div>
              <pre>{tc.result.length > 2000 ? tc.result.slice(0, 2000) + '\n…（已截斷）' : tc.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
