import { useState } from 'react';
import { useStore } from '../store';

export function NewSessionButton() {
  const groups = useStore((s) => s.groups);
  const createSession = useStore((s) => s.createSession);
  const [open, setOpen] = useState(false);

  const handleCreate = async (groupId: string) => {
    setOpen(false);
    await createSession(groupId);
  };

  return (
    <div className="new-session-wrapper">
      <button className="btn btn-primary new-session-btn" onClick={() => setOpen(!open)}>
        ＋ 新對話
      </button>
      {open && (
        <>
          <div className="new-session-backdrop" onClick={() => setOpen(false)} />
          <div className="new-session-dropdown">
            <div className="new-session-dropdown-title">選擇群組</div>
            {groups.map((g) => (
              <div
                key={g.id}
                className="new-session-option"
                onClick={() => handleCreate(g.id)}
              >
                <span className="group-icon">{g.icon ?? '📁'}</span>
                <div className="new-session-option-info">
                  <div className="new-session-option-name">{g.displayName}</div>
                  {g.description && (
                    <div className="new-session-option-desc">{g.description}</div>
                  )}
                </div>
              </div>
            ))}
            {groups.length === 0 && (
              <div className="sidebar-empty">尚無可用群組</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
