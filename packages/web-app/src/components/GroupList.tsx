import { useStore } from '../store';

export function GroupList() {
  const groups = useStore((s) => s.groups);

  return (
    <div className="sidebar-section">
      <div className="section-title">Groups</div>
      {groups.map((g) => (
        <div key={g.id} className="item group-item" title={g.description}>
          <span className="group-icon">{g.icon ?? '📁'}</span>
          <span className="group-name">{g.displayName}</span>
          <span className="group-agents-count">{g.agents.length} 代理</span>
        </div>
      ))}
      {groups.length === 0 && (
        <div className="sidebar-empty">尚無群組</div>
      )}
    </div>
  );
}
