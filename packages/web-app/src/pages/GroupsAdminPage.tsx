import { useEffect, useState } from 'react';
import { useStore, type AdminGroupRecord, type AdminGroupPatch } from '../store';
import { ThemeToggle } from '../components/ThemeToggle';

export function GroupsAdminPage() {
  const adminGroups = useStore((s) => s.adminGroups);
  const loadAdminGroups = useStore((s) => s.loadAdminGroups);
  const patchAdminGroup = useStore((s) => s.patchAdminGroup);
  const resetAdminGroup = useStore((s) => s.resetAdminGroup);
  const setToken = useStore((s) => s.setToken);
  const role = useStore((s) => s.role);
  const userId = useStore((s) => s.userId);

  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    void loadAdminGroups()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [loadAdminGroups]);

  useEffect(() => {
    if (!selected && adminGroups.length > 0) {
      setSelected(adminGroups[0]!.id);
    }
  }, [adminGroups, selected]);

  const selectedGroup = adminGroups.find((g) => g.id === selected);

  return (
    <div className="admin-page" style={{ height: '100vh', overflow: 'hidden' }}>
      <header className="admin-header">
        <div className="admin-header-title">
          <h1>Agent Groups</h1>
          <span className="admin-header-user">
            {userId} &middot; <span className={`role-tag role-${role}`}>{role}</span>
          </span>
        </div>
        <div className="admin-header-actions">
          <a href="/admin" className="btn btn-sm btn-ghost">Back</a>
          <button className="btn btn-sm btn-ghost" onClick={() => setToken(null)}>Logout</button>
          <ThemeToggle />
        </div>
      </header>

      {error && (
        <div className="admin-error" style={{ margin: '10px 20px 0' }}>{error}</div>
      )}

      <div className="ga-body">
        <aside className="ga-sidebar">
          {loading ? (
            <div style={{ padding: '16px', color: 'var(--text-dim)', fontSize: 13 }}>Loading...</div>
          ) : adminGroups.length === 0 ? (
            <div style={{ padding: '16px', color: 'var(--text-dim)', fontSize: 13 }}>
              No groups - check groups.yaml
            </div>
          ) : (
            adminGroups.map((g) => (
              <button
                key={g.id}
                className={[
                  'ga-sidebar-item',
                  selected === g.id ? 'ga-sidebar-item-active' : '',
                  !g.enabled ? 'ga-sidebar-item-disabled' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setSelected(g.id)}
              >
                <span className="ga-sidebar-icon">{g.icon ?? '\u{1f4c1}'}</span>
                <div className="ga-sidebar-info">
                  <span className="ga-sidebar-name">{g.displayName}</span>
                  <span className="ga-sidebar-id">{g.id}</span>
                </div>
                <div className="ga-sidebar-badges">
                  {!g.enabled && <span className="ga-badge ga-badge-off">OFF</span>}
                  {g.hasOverride && <span className="ga-badge ga-badge-ov">OV</span>}
                </div>
              </button>
            ))
          )}
        </aside>

        <div className="ga-detail">
          {selectedGroup ? (
            <GroupDetail
              key={selectedGroup.id}
              group={selectedGroup}
              onSave={async (patch) => {
                try {
                  await patchAdminGroup(selectedGroup.id, patch);
                  setError(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              onReset={async () => {
                if (!confirm(`Reset all overrides for "${selectedGroup.displayName}" back to yaml defaults?`)) return;
                try {
                  await resetAdminGroup(selectedGroup.id);
                  setError(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            />
          ) : !loading ? (
            <div className="ga-empty">Select a group on the left</div>
          ) : null}
        </div>
      </div>

    </div>
  );
}

function GroupDetail(props: {
  group: AdminGroupRecord;
  onSave: (patch: AdminGroupPatch) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const { group: g, onSave, onReset } = props;

  const [displayName, setDisplayName] = useState(g.displayName);
  const [description, setDescription] = useState(g.description ?? '');
  const [icon, setIcon] = useState(g.icon ?? '');
  const [enabled, setEnabled] = useState(g.enabled);
  const [defaultAgent, setDefaultAgent] = useState(g.defaultAgent ?? '');
  const [maxSessions, setMaxSessions] = useState(String(g.maxSessions));
  const [routingMode, setRoutingMode] = useState<'explicit' | 'auto' | 'round-robin'>(g.routingMode);
  const [routingFallback, setRoutingFallback] = useState(g.routingFallback ?? '');
  const [routingAutoClassifierModel, setRoutingAutoClassifierModel] = useState(g.routingAutoClassifierModel ?? '');
  const [saving, setSaving] = useState(false);

  const isDirty =
    displayName !== g.displayName ||
    description !== (g.description ?? '') ||
    icon !== (g.icon ?? '') ||
    enabled !== g.enabled ||
    defaultAgent !== (g.defaultAgent ?? '') ||
    maxSessions !== String(g.maxSessions) ||
    routingMode !== g.routingMode ||
    routingFallback !== (g.routingFallback ?? '') ||
    routingAutoClassifierModel !== (g.routingAutoClassifierModel ?? '');

  function revertLocal() {
    setDisplayName(g.displayName);
    setDescription(g.description ?? '');
    setIcon(g.icon ?? '');
    setEnabled(g.enabled);
    setDefaultAgent(g.defaultAgent ?? '');
    setMaxSessions(String(g.maxSessions));
    setRoutingMode(g.routingMode);
    setRoutingFallback(g.routingFallback ?? '');
    setRoutingAutoClassifierModel(g.routingAutoClassifierModel ?? '');
  }

  async function save() {
    setSaving(true);
    const patch: AdminGroupPatch = {};
    if (displayName !== g.displayName) patch.displayName = displayName;
    if (description !== (g.description ?? '')) patch.description = description;
    if (icon !== (g.icon ?? '')) patch.icon = icon;
    if (enabled !== g.enabled) patch.enabled = enabled;
    if (defaultAgent !== (g.defaultAgent ?? '')) patch.defaultAgent = defaultAgent || undefined;
    const ms = parseInt(maxSessions, 10);
    if (!isNaN(ms) && ms !== g.maxSessions) patch.maxSessions = ms;
    if (routingMode !== g.routingMode) patch.routingMode = routingMode;
    const fb = routingFallback.trim();
    if (fb !== (g.routingFallback ?? '')) patch.routingFallback = fb || null;
    const acm = routingAutoClassifierModel.trim();
    if (acm !== (g.routingAutoClassifierModel ?? '')) patch.routingAutoClassifierModel = acm || null;
    try {
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  }

  const previewIcon = icon || g.icon || '\u{1f4c1}';
  const previewName = displayName || g.displayName;

  return (
    <div className="ga-detail-inner">
      <div className="ga-detail-header">
        <div className="ga-detail-title">
          <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>{previewIcon}</span>
          <div style={{ minWidth: 0 }}>
            <div className="ga-detail-name">{previewName}</div>
            <div className="ga-detail-meta">
              <code className="ga-code">{g.id}</code>
              {!enabled && <span className="ga-badge ga-badge-off">DISABLED</span>}
              {g.hasOverride && <span className="ga-badge ga-badge-ov">OVERRIDDEN</span>}
            </div>
          </div>
        </div>
        <div className="ga-detail-actions">
          {g.hasOverride && (
            <button className="btn btn-sm btn-ghost" onClick={() => void onReset()} disabled={saving}>
              Reset to yaml
            </button>
          )}
          {isDirty && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={revertLocal} disabled={saving}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="ga-sections">
        <section className="ga-section">
          <div className="ga-section-header">
            <span className="ga-section-title">Display</span>
            <span className="ga-section-badge">Live</span>
          </div>
          <div className="ga-section-body">
            <div className="ga-row">
              <div className="ga-field" style={{ flex: '0 0 72px' }}>
                <label className="ga-label">Icon</label>
                <input
                  className="mg-form-input"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder={'\u{1f4c1}'}
                  style={{ textAlign: 'center', fontSize: 20, padding: '6px' }}
                />
              </div>
              <div className="ga-field" style={{ flex: 1, minWidth: 160 }}>
                <label className="ga-label">Display Name <span className="ga-required">*</span></label>
                <input
                  className="mg-form-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="ga-field" style={{ flex: '0 0 auto' }}>
                <label className="ga-label">Enabled</label>
                <label className="ga-toggle">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                  <span className={`ga-toggle-track${enabled ? ' ga-toggle-on' : ''}`}>
                    {enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              </div>
            </div>
            <div className="ga-field">
              <label className="ga-label">Description</label>
              <input
                className="mg-form-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional short description shown in the chat menu"
              />
            </div>
          </div>
        </section>

        <section className="ga-section">
          <div className="ga-section-header">
            <span className="ga-section-title">Routing</span>
            <span className="ga-section-badge">Live</span>
          </div>
          <div className="ga-section-body">
            <div className="ga-row">
              <div className="ga-field" style={{ flex: 1, minWidth: 180 }}>
                <label className="ga-label">Routing Mode</label>
                <select
                  className="mg-form-select"
                  value={routingMode}
                  onChange={(e) => setRoutingMode(e.target.value as 'explicit' | 'auto' | 'round-robin')}
                >
                  <option value="explicit">explicit - client picks agent</option>
                  <option value="auto">auto - LLM classifier</option>
                  <option value="round-robin">round-robin - distribute evenly</option>
                </select>
              </div>
              <div className="ga-field" style={{ flex: 1, minWidth: 180 }}>
                <label className="ga-label">Default Agent</label>
                <select
                  className="mg-form-select"
                  value={defaultAgent}
                  onChange={(e) => setDefaultAgent(e.target.value)}
                >
                  <option value="">(use agents[0])</option>
                  {g.agents.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="ga-row">
              <div className="ga-field" style={{ flex: 1, minWidth: 180 }}>
                <label className="ga-label">Fallback Agent</label>
                <select
                  className="mg-form-select"
                  value={routingFallback}
                  onChange={(e) => setRoutingFallback(e.target.value)}
                >
                  <option value="">(none)</option>
                  {g.agents.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
              <div className="ga-field" style={{ flex: 1, minWidth: 180 }}>
                <label className="ga-label">
                  Auto Classifier Model
                  {routingMode !== 'auto' && <span className="ga-readonly-badge">mode=auto only</span>}
                </label>
                <input
                  className="mg-form-input"
                  value={routingAutoClassifierModel}
                  onChange={(e) => setRoutingAutoClassifierModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  disabled={routingMode !== 'auto'}
                  style={{ opacity: routingMode !== 'auto' ? 0.45 : 1 }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="ga-section">
          <div className="ga-section-header">
            <span className="ga-section-title">Container</span>
            <span className="ga-section-badge ga-section-badge-warn">Some require restart</span>
          </div>
          <div className="ga-section-body">
            <div className="ga-row">
              <div className="ga-field" style={{ flex: 1, minWidth: 200 }}>
                <label className="ga-label">
                  Base Image <span className="ga-readonly-badge">yaml-only</span>
                </label>
                <div className="ga-readonly-field">
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{g.baseImage}</code>
                </div>
              </div>
              <div className="ga-field" style={{ flex: '0 0 160px' }}>
                <label className="ga-label">
                  Max Sessions <span className="ga-required">Live</span>
                </label>
                <input
                  className="mg-form-input"
                  type="number"
                  min="1"
                  max="1000"
                  value={maxSessions}
                  onChange={(e) => setMaxSessions(e.target.value)}
                />
              </div>
            </div>
            <div className="ga-row">
              <div className="ga-field" style={{ flex: '0 0 auto' }}>
                <label className="ga-label">Mount Agents Dir <span className="ga-readonly-badge">yaml-only</span></label>
                <div className="ga-readonly-field">{g.mountAgentsDir ? 'true' : 'false'}</div>
              </div>
              <div className="ga-field" style={{ flex: '0 0 140px' }}>
                <label className="ga-label">CPU Limit <span className="ga-readonly-badge">yaml-only</span></label>
                <div className="ga-readonly-field">{g.cpuLimit ?? '—'}</div>
              </div>
              <div className="ga-field" style={{ flex: '0 0 140px' }}>
                <label className="ga-label">Memory Limit <span className="ga-readonly-badge">yaml-only</span></label>
                <div className="ga-readonly-field">{g.memoryLimit ?? '—'}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="ga-section">
          <div className="ga-section-header">
            <span className="ga-section-title">Agents</span>
            <span className="ga-section-badge ga-section-badge-warn">yaml-only</span>
          </div>
          <div className="ga-section-body">
            <div className="ga-agents">
              {g.agents.map((a) => {
                const isDefault = a === (defaultAgent || g.defaultAgent || g.agents[0]);
                return (
                  <span key={a} className={`ga-agent-chip${isDefault ? ' ga-agent-chip-default' : ''}`}>
                    {a}
                    {isDefault && <span className="ga-agent-default-mark">default</span>}
                  </span>
                );
              })}
            </div>
            {g.agents.length === 0 && (
              <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
                No agents - add agents[] in groups.yaml
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
