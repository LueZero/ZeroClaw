import { useStore } from '../store';

function relativeTime(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '剛剛';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);

  return (
    <div className="sidebar-section">
      <div className="section-title">Sessions</div>
      {sessions.map((s) => (
        <div
          key={s.sessionId}
          className={`item session-item ${s.sessionId === currentSessionId ? 'active' : ''}`}
          onClick={() => selectSession(s.sessionId)}
        >
          <div className="session-item-row">
            <span className="session-item-title">{s.title ?? s.agentId}</span>
            <span className={`session-status-dot ${s.status}`} title={s.status} />
          </div>
          <div className="session-item-row session-item-meta">
            <span className="session-id mono">{s.sessionId.slice(0, 8)}</span>
            <span className="session-meta-sep">·</span>
            <span>{s.groupId}</span>
            <span className="session-meta-sep">·</span>
            <span>{s.messageCount ?? 0} 則</span>
          </div>
          <div className="session-item-row session-item-meta">
            <span>{relativeTime(s.lastMessageAt)}</span>
          </div>
          <button
            className="session-item-delete"
            onClick={(e) => {
              e.stopPropagation();
              deleteSession(s.sessionId);
            }}
            title="刪除 Session"
          >
            ×
          </button>
        </div>
      ))}
      {sessions.length === 0 && (
        <div className="sidebar-empty">尚無 Session</div>
      )}
    </div>
  );
}
