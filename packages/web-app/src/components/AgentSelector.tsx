import { useEffect, useState } from 'react';
import { useStore } from '../store';

export function AgentSelector() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessions = useStore((s) => s.sessions);
  const agents = useStore((s) => s.agents);
  const loadAgentsForGroup = useStore((s) => s.loadAgentsForGroup);

  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const groupId = currentSession?.groupId;
  const groupAgents = groupId ? agents[groupId] : undefined;

  useEffect(() => {
    if (groupId && !groupAgents) {
      loadAgentsForGroup(groupId);
    }
  }, [groupId, groupAgents, loadAgentsForGroup]);

  const [open, setOpen] = useState(false);

  if (!currentSession || !groupAgents || groupAgents.length <= 1) return null;

  return (
    <div className="agent-selector">
      <span className="agent-selector-label mono">ACTIVE AGENT</span>
      <button
        className="agent-selector-trigger"
        onClick={() => setOpen(!open)}
      >
        🤖 {groupAgents.find((a) => a.id === currentSession.agentId)?.displayName ?? currentSession.agentId}
        <span className="agent-selector-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="agent-selector-dropdown">
          {groupAgents.map((a) => (
            <div
              key={a.id}
              className={`agent-selector-option ${a.id === currentSession.agentId ? 'active' : ''}`}
              onClick={() => {
                if (a.id !== currentSession.agentId) {
                  useStore.getState().api('/api/sessions/' + currentSession.sessionId + '/switchAgent', {
                    method: 'POST',
                    body: JSON.stringify({ agentId: a.id }),
                  }).then(() => useStore.getState().loadSessions());
                }
                setOpen(false);
              }}
            >
              <div className="agent-option-name">{a.displayName}</div>
              {a.description && <div className="agent-option-desc">{a.description}</div>}
              <span className={`agent-sdk-badge ${a.sdk}`}>{a.sdk}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
