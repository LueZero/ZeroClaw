import { useEffect, useState, useCallback } from 'react';
import { useStore, type MessagingGroupRecord, type WiringRecord, type WiringInput } from '../store';
import { ThemeToggle } from '../components/ThemeToggle';

const PLATFORMS = ['telegram', 'slack', 'discord', 'whatsapp', 'teams'] as const;

// ─── Pairing Modal ─────────────────────────────────────────────────────────────

function PairingModal({ onClose }: { onClose: () => void }) {
  const groups = useStore((s) => s.groups);
  const agents = useStore((s) => s.agents);
  const loadAgentsForGroup = useStore((s) => s.loadAgentsForGroup);
  const createPairing = useStore((s) => s.createPairing);

  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [agentId, setAgentId] = useState('');
  const [platform, setPlatform] = useState<string>('telegram');
  const [engageMode, setEngageMode] = useState<string>('pattern');
  const [engagePattern, setEngagePattern] = useState('.');
  const [sessionMode, setSessionMode] = useState<string>('per-user');
  const [result, setResult] = useState<{ code: string; groupId: string; platform: string; agentId: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (groupId) void loadAgentsForGroup(groupId);
  }, [groupId, loadAgentsForGroup]);

  useEffect(() => {
    setAgentId((agents[groupId] ?? [])[0]?.id ?? '');
  }, [agents, groupId]);

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const r = await createPairing({
        groupId,
        platform,
        agentId: agentId || undefined,
        engageMode,
        engagePattern: engageMode === 'pattern' ? engagePattern : undefined,
        sessionMode,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>產生綁定 Code</h3>
        {result ? (
          <>
            <div className="mg-pairing-result">
              <div className="mg-pairing-code">{result.code}</div>
              <div className="mg-pairing-meta">
                平台：{result.platform} · 代理人群組：{result.groupId} · 代理人：{result.agentId ?? '預設'}
              </div>
            </div>
            <p className="mg-hint">請將此 code 貼到目標 chat，bot 會自動完成綁定。</p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose}>關閉</button>
            </div>
          </>
        ) : (
          <>
            <div className="mg-form-field">
              <label className="mg-form-label">平台</label>
              <select className="mg-form-select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="mg-form-field">
              <label className="mg-form-label" title="groups.yaml 中定義的代理人邏輯群組（含 routing/container 設定），與通訊軟體的「群組頻道」無關">
                代理人群組 (Agent Group)
              </label>
              <select className="mg-form-select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.displayName || g.id}</option>)}
              </select>
            </div>
            <div className="mg-form-field">
              <label className="mg-form-label">代理人</label>
              <select className="mg-form-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">（預設）</option>
                {(agents[groupId] ?? []).map((a) => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
              </select>
            </div>
            <div className="mg-form-field">
              <label className="mg-form-label">觸發模式</label>
              <select className="mg-form-select" value={engageMode} onChange={(e) => setEngageMode(e.target.value)}>
                <option value="pattern">pattern（regex）</option>
                <option value="mention">mention（@bot）</option>
                <option value="mention-sticky">mention-sticky（@bot + thread 黏著）</option>
              </select>
            </div>
            {engageMode === 'pattern' && (
              <div className="mg-form-field">
                <label className="mg-form-label">Pattern</label>
                <input className="mg-form-input" value={engagePattern} onChange={(e) => setEngagePattern(e.target.value)} placeholder=". = 永遠觸發" />
                <span className="mg-hint"><code>.</code> = 永遠觸發；<code>^/dev</code> = 指令前綴</span>
              </div>
            )}
            <div className="mg-form-field">
              <label className="mg-form-label">Session 模式</label>
              <select className="mg-form-select" value={sessionMode} onChange={(e) => setSessionMode(e.target.value)}>
                <option value="per-user">per-user（預設，每個 user 獨立）</option>
                <option value="per-thread">per-thread（thread × user）</option>
                <option value="shared">shared（整群共用 ⚠️）</option>
                <option value="agent-shared">agent-shared（跨 chat ⚠️）</option>
              </select>
            </div>
            {error && <div className="admin-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>取消</button>
              <button className="btn btn-primary" disabled={loading || !groupId} onClick={() => void submit()}>
                {loading ? '產生中…' : '產生'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Add Wiring Form ───────────────────────────────────────────────────────────

function AddWiringForm({ mgId, existingWirings, onDone }: { mgId: string; existingWirings: WiringRecord[]; onDone: () => void }) {
  const groups = useStore((s) => s.groups);
  const agents = useStore((s) => s.agents);
  const loadAgentsForGroup = useStore((s) => s.loadAgentsForGroup);
  const addWiring = useStore((s) => s.addWiring);

  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [agentId, setAgentId] = useState('');
  const [engageMode, setEngageMode] = useState<string>('pattern');
  const [engagePattern, setEngagePattern] = useState('.');
  const [sessionMode, setSessionMode] = useState<string>('per-user');
  const [ignoredMessagePolicy, setIgnoredMessagePolicy] = useState<string>('accumulate');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (groupId) void loadAgentsForGroup(groupId);
  }, [groupId, loadAgentsForGroup]);

  useEffect(() => {
    setAgentId((agents[groupId] ?? [])[0]?.id ?? '');
  }, [agents, groupId]);

  const alwaysOnCount = existingWirings.filter(
    (w) => w.engageMode === 'pattern' && (w.engagePattern === '.' || !w.engagePattern),
  ).length;

  async function submit() {
    if (!groupId || !agentId) return;
    // duplicate check
    if (existingWirings.some((w) => w.groupId === groupId && w.agentId === agentId)) {
      setError(`此 chat 已有 ${groupId}/${agentId} 的 wiring。`);
      return;
    }
    if (engageMode === 'pattern' && (engagePattern === '.' || engagePattern === '') && alwaysOnCount > 0) {
      if (!confirm(`此 chat 已有 ${alwaysOnCount} 個全收 agent，新增後都會收到所有訊息，確定？`)) return;
    }
    setLoading(true);
    setError(null);
    try {
      const input: WiringInput = {
        groupId,
        agentId,
        engageMode: engageMode as WiringInput['engageMode'],
        sessionMode: sessionMode as WiringInput['sessionMode'],
        ignoredMessagePolicy: ignoredMessagePolicy as WiringInput['ignoredMessagePolicy'],
      };
      if (engageMode === 'pattern') input.engagePattern = engagePattern || '.';
      await addWiring(mgId, input);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mg-card mg-card-inner">
      <h4 style={{ margin: '0 0 12px' }}>新增 Wiring</h4>
      <div className="mg-form-grid">
        <div className="mg-form-field">
          <label className="mg-form-label" title="groups.yaml 中定義的代理人邏輯群組（含 routing/container 設定），與通訊軟體的「群組頻道」無關">
            代理人群組 (Agent Group)
          </label>
          <select className="mg-form-select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.displayName || g.id}</option>)}
          </select>
        </div>
        <div className="mg-form-field">
          <label className="mg-form-label">代理人</label>
          <select className="mg-form-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">— 選擇 —</option>
            {(agents[groupId] ?? []).map((a) => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </div>
        <div className="mg-form-field">
          <label className="mg-form-label">觸發模式</label>
          <select className="mg-form-select" value={engageMode} onChange={(e) => setEngageMode(e.target.value)}>
            <option value="pattern">pattern</option>
            <option value="mention">mention</option>
            <option value="mention-sticky">mention-sticky</option>
          </select>
        </div>
        {engageMode === 'pattern' && (
          <div className="mg-form-field">
            <label className="mg-form-label">Pattern</label>
            <input className="mg-form-input" value={engagePattern} onChange={(e) => setEngagePattern(e.target.value)} placeholder="." />
          </div>
        )}
        <div className="mg-form-field">
          <label className="mg-form-label">Session 模式</label>
          <select className="mg-form-select" value={sessionMode} onChange={(e) => setSessionMode(e.target.value)}>
            <option value="per-user">per-user</option>
            <option value="per-thread">per-thread</option>
            <option value="shared">shared ⚠️</option>
            <option value="agent-shared">agent-shared ⚠️</option>
          </select>
        </div>
        <div className="mg-form-field">
          <label className="mg-form-label">未觸發訊息</label>
          <select className="mg-form-select" value={ignoredMessagePolicy} onChange={(e) => setIgnoredMessagePolicy(e.target.value)}>
            <option value="drop">drop（丟棄）</option>
            <option value="accumulate">accumulate（累積 context）</option>
          </select>
        </div>
      </div>
      {error && <div className="admin-error" style={{ marginTop: 8 }}>{error}</div>}
      <div className="mg-form-actions">
        <button className="btn btn-sm btn-ghost" onClick={onDone}>取消</button>
        <button className="btn btn-sm btn-primary" disabled={loading || !agentId} onClick={() => void submit()}>
          {loading ? '新增中…' : '新增 Wiring'}
        </button>
      </div>
    </div>
  );
}

// ─── Edit Wiring Inline ────────────────────────────────────────────────────────

function EditWiringInline({ mgId, wiring, onDone }: { mgId: string; wiring: WiringRecord; onDone: () => void }) {
  const updateWiring = useStore((s) => s.updateWiring);
  const [engageMode, setEngageMode] = useState(wiring.engageMode);
  const [engagePattern, setEngagePattern] = useState(wiring.engagePattern ?? '.');
  const [sessionMode, setSessionMode] = useState(wiring.sessionMode);
  const [ignoredMessagePolicy, setIgnoredMessagePolicy] = useState(wiring.ignoredMessagePolicy);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      await updateWiring(mgId, wiring.groupId, wiring.agentId, {
        engageMode,
        engagePattern: engageMode === 'pattern' ? (engagePattern || '.') : undefined,
        sessionMode,
        ignoredMessagePolicy,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mg-card mg-card-inner">
      <div className="mg-form-grid">
        <div className="mg-form-field">
          <label className="mg-form-label">觸發模式</label>
          <select className="mg-form-select" value={engageMode} onChange={(e) => setEngageMode(e.target.value as typeof engageMode)}>
            <option value="pattern">pattern</option>
            <option value="mention">mention</option>
            <option value="mention-sticky">mention-sticky</option>
          </select>
        </div>
        {engageMode === 'pattern' && (
          <div className="mg-form-field">
            <label className="mg-form-label">Pattern</label>
            <input className="mg-form-input" value={engagePattern} onChange={(e) => setEngagePattern(e.target.value)} />
          </div>
        )}
        <div className="mg-form-field">
          <label className="mg-form-label">Session 模式</label>
          <select className="mg-form-select" value={sessionMode} onChange={(e) => setSessionMode(e.target.value as typeof sessionMode)}>
            <option value="per-user">per-user</option>
            <option value="per-thread">per-thread</option>
            <option value="shared">shared ⚠️</option>
            <option value="agent-shared">agent-shared ⚠️</option>
          </select>
        </div>
        <div className="mg-form-field">
          <label className="mg-form-label">未觸發訊息</label>
          <select className="mg-form-select" value={ignoredMessagePolicy} onChange={(e) => setIgnoredMessagePolicy(e.target.value as typeof ignoredMessagePolicy)}>
            <option value="drop">drop</option>
            <option value="accumulate">accumulate</option>
          </select>
        </div>
      </div>
      {error && <div className="admin-error" style={{ marginTop: 8 }}>{error}</div>}
      <div className="mg-form-actions">
        <button className="btn btn-sm btn-ghost" onClick={onDone}>取消</button>
        <button className="btn btn-sm btn-primary" disabled={loading} onClick={() => void submit()}>
          {loading ? '儲存中…' : '儲存'}
        </button>
      </div>
    </div>
  );
}

// ─── Wiring Row ────────────────────────────────────────────────────────────────

function WiringRow({ mgId, wiring, onRemoved }: { mgId: string; wiring: WiringRecord; onRemoved: () => void }) {
  const removeWiring = useStore((s) => s.removeWiring);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    if (!confirm(`確定要刪除 wiring ${wiring.groupId}/${wiring.agentId}？`)) return;
    setRemoving(true);
    try {
      await removeWiring(mgId, wiring.groupId, wiring.agentId);
      onRemoved();
    } finally {
      setRemoving(false);
    }
  }

  if (editing) {
    return <EditWiringInline mgId={mgId} wiring={wiring} onDone={() => setEditing(false)} />;
  }

  const isAlwaysOn = wiring.engageMode === 'pattern' && (wiring.engagePattern === '.' || !wiring.engagePattern);

  return (
    <div className="mg-wiring-row">
      <div className="mg-wiring-cells">
        <span className="mg-wiring-cell mg-wiring-group mono">{wiring.groupId}</span>
        <span className="mg-wiring-cell mg-wiring-agent mono">{wiring.agentId}</span>
        <span className="mg-wiring-cell">
          <span className={`mg-tag mg-tag-${wiring.engageMode}`}>{wiring.engageMode}</span>
        </span>
        <span className="mg-wiring-cell mono">
          {wiring.engageMode === 'pattern' ? (wiring.engagePattern ?? '.') : '—'}
          {isAlwaysOn && <span className="mg-tag mg-tag-warn" style={{ marginLeft: 6 }}>全收</span>}
        </span>
        <span className="mg-wiring-cell">
          <span className={`mg-tag ${wiring.sessionMode === 'shared' || wiring.sessionMode === 'agent-shared' ? 'mg-tag-warn' : ''}`}>
            {wiring.sessionMode}
          </span>
        </span>
        <span className="mg-wiring-cell">{wiring.ignoredMessagePolicy}</span>
      </div>
      <div className="mg-wiring-actions">
        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>編輯</button>
        <button className="btn btn-sm btn-danger" disabled={removing} onClick={() => void handleRemove()}>
          {removing ? '…' : '刪除'}
        </button>
      </div>
    </div>
  );
}

// ─── Messaging Group Card ──────────────────────────────────────────────────────

function MessagingGroupCard({ mg, onRefresh }: { mg: MessagingGroupRecord; onRefresh: () => void }) {
  const deleteMessagingGroup = useStore((s) => s.deleteMessagingGroup);
  const updateMessagingGroup = useStore((s) => s.updateMessagingGroup);
  const [expanded, setExpanded] = useState(false);
  const [showAddWiring, setShowAddWiring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`確定要刪除 ${mg.platform} / ${mg.platformChatId}？\n此操作會連帶刪除所有 wirings。`)) return;
    setDeleting(true);
    try {
      await deleteMessagingGroup(mg.id);
    } finally {
      setDeleting(false);
    }
  }

  async function toggleDenied() {
    const deny = !mg.deniedAt;
    if (deny && !confirm('確定要封鎖此 chat？封鎖後所有訊息將被忽略。')) return;
    await updateMessagingGroup(mg.id, { denied: deny });
  }

  return (
    <div className={`mg-card${mg.deniedAt ? ' mg-card-denied' : ''}`}>
      {/* header row */}
      <div className="mg-card-head" onClick={() => setExpanded((v) => !v)}>
        <span className="mg-card-caret">{expanded ? '▾' : '▸'}</span>
        <span className={`mg-tag mg-tag-platform mg-tag-${mg.platform}`}>{mg.platform}</span>
        <span className="mg-card-chatid mono" title={mg.platformChatId}>{mg.platformChatId}</span>
        <span className={`mg-tag ${mg.isGroup ? '' : 'mg-tag-dm'}`}>{mg.isGroup ? '群組' : 'DM'}</span>
        <span className="mg-card-count">{(mg.wirings ?? []).length} wiring{(mg.wirings ?? []).length !== 1 ? 's' : ''}</span>
        {mg.deniedAt && <span className="mg-tag mg-tag-warn">已封鎖</span>}
        {mg.wirings.length === 0 && <span className="mg-tag mg-tag-pending">待設定</span>}
      </div>

      {expanded && (
        <div className="mg-card-body">
          {/* quick actions */}
          <div className="mg-card-toolbar">
            <button className="btn btn-sm btn-ghost" onClick={() => void toggleDenied()}>
              {mg.deniedAt ? '解除封鎖' : '封鎖'}
            </button>
            <button className="btn btn-sm btn-danger" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? '刪除中…' : '刪除 Chat'}
            </button>
            <span className="mg-card-id mono">ID: {mg.id}</span>
          </div>

          {/* wirings table */}
          {(mg.wirings ?? []).length > 0 && (
            <div className="mg-wirings-list">
              <div className="mg-wirings-head">
                <span>Group</span><span>Agent</span><span>Engage</span><span>Pattern</span><span>Session</span><span>Policy</span>
              </div>
              {(mg.wirings ?? []).map((w) => (
                <WiringRow key={`${w.groupId}-${w.agentId}`} mgId={mg.id} wiring={w} onRemoved={onRefresh} />
              ))}
            </div>
          )}

          {(mg.wirings ?? []).length === 0 && !showAddWiring && (
            <div className="admin-empty" style={{ padding: '20px 14px' }}>
              尚無 wiring — 點「新增 Wiring」綁定代理人。
            </div>
          )}

          {showAddWiring ? (
            <AddWiringForm
              mgId={mg.id}
              existingWirings={mg.wirings ?? []}
              onDone={() => { setShowAddWiring(false); }}
            />
          ) : (
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAddWiring(true)}>
              ＋ 新增 Wiring
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Add Messaging Group Form ──────────────────────────────────────────────────

function AddMessagingGroupForm({ onDone }: { onDone: () => void }) {
  const createMessagingGroup = useStore((s) => s.createMessagingGroup);
  const [platform, setPlatform] = useState('telegram');
  const [chatId, setChatId] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!chatId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await createMessagingGroup({ platform, platformChatId: chatId.trim(), isGroup });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mg-card mg-card-inner">
      <h4 style={{ margin: '0 0 12px' }}>手動新增 Messaging Group</h4>
      <div className="mg-form-grid">
        <div className="mg-form-field">
          <label className="mg-form-label">平台</label>
          <select className="mg-form-select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="mg-form-field">
          <label className="mg-form-label">Chat ID</label>
          <input className="mg-form-input" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="平台 chat/channel/user ID" />
        </div>
        <div className="mg-form-field">
          <label className="mg-form-label mg-form-label-check">
            <input type="checkbox" checked={isGroup} onChange={(e) => setIsGroup(e.target.checked)} />
            群組/頻道（非 DM）
          </label>
        </div>
      </div>
      {error && <div className="admin-error" style={{ marginTop: 8 }}>{error}</div>}
      <div className="mg-form-actions">
        <button className="btn btn-sm btn-ghost" onClick={onDone}>取消</button>
        <button className="btn btn-sm btn-primary" disabled={loading || !chatId.trim()} onClick={() => void submit()}>
          {loading ? '新增中…' : '新增'}
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function MessagingGroupsPage() {
  const messagingGroups = useStore((s) => s.messagingGroups);
  const loadMessagingGroups = useStore((s) => s.loadMessagingGroups);
  const loadGroups = useStore((s) => s.loadGroups);
  const setToken = useStore((s) => s.setToken);
  const userId = useStore((s) => s.userId);
  const role = useStore((s) => s.role);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPairing, setShowPairing] = useState(false);
  const [showAddMg, setShowAddMg] = useState(false);
  const [filter, setFilter] = useState<'all' | 'no-wiring' | 'denied'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadMessagingGroups(), loadGroups()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadMessagingGroups, loadGroups]);

  useEffect(() => { void load(); }, [load]);

  const filtered = messagingGroups.filter((mg) => {
    if (filter === 'no-wiring') return (mg.wirings ?? []).length === 0;
    if (filter === 'denied') return !!mg.deniedAt;
    return true;
  });

  const noWiringCount = messagingGroups.filter((mg) => (mg.wirings ?? []).length === 0).length;

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-title">
          <h1>Messaging Groups</h1>
          <span className="admin-header-user">
            {userId} · <span className={`role-tag role-${role}`}>{role}</span>
          </span>
        </div>
        <div className="admin-header-actions">
          <a href="/admin" className="btn btn-sm btn-ghost">← 管理後台</a>
          <ThemeToggle />
          <a href="/chat" className="btn btn-sm btn-ghost">聊天</a>
          <button className="btn btn-sm btn-ghost" onClick={() => setToken(null)}>登出</button>
        </div>
      </header>

      {showPairing && <PairingModal onClose={() => { setShowPairing(false); void load(); }} />}

      <div className="admin-content">
        {/* stats */}
        <section className="admin-section">
          <div className="admin-stats">
            <div className="admin-stat">
              <div className="admin-stat-value">{messagingGroups.length}</div>
              <div className="admin-stat-label">Messaging Groups</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">
                {messagingGroups.reduce((s, mg) => s + (mg.wirings ?? []).length, 0)}
              </div>
              <div className="admin-stat-label">總 Wirings</div>
            </div>
            <div className={`admin-stat${noWiringCount > 0 ? ' admin-stat-warn' : ''}`}>
              <div className="admin-stat-value">{noWiringCount}</div>
              <div className="admin-stat-label">待設定</div>
            </div>
          </div>
        </section>

        {/* toolbar */}
        <section className="admin-section">
          <div className="admin-section-header">
            <h2>群組列表</h2>
            <div className="admin-section-actions">
              <select className="mg-form-select" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ padding: '5px 8px', fontSize: 12 }}>
                <option value="all">全部</option>
                <option value="no-wiring">待設定（無 wiring）</option>
                <option value="denied">已封鎖</option>
              </select>
              <button className="btn btn-sm btn-ghost" onClick={() => void load()} disabled={loading}>
                {loading ? '載入中…' : '🔄 刷新'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setShowAddMg((v) => !v)}>＋ 手動新增</button>
              <button className="btn btn-sm btn-primary" onClick={() => setShowPairing(true)}>產生綁定 Code</button>
            </div>
          </div>

          {error && <div className="admin-error">⚠️ {error}</div>}

          {showAddMg && <AddMessagingGroupForm onDone={() => { setShowAddMg(false); void load(); }} />}

          {loading && messagingGroups.length === 0 ? (
            <div className="admin-empty">載入中…</div>
          ) : filtered.length === 0 ? (
            <div className="admin-empty">
              {filter !== 'all'
                ? '沒有符合篩選條件的 Messaging Group。'
                : '尚無 Messaging Group。使用「產生綁定 Code」讓 bot 自動建立，或手動新增。'}
            </div>
          ) : (
            <div className="mg-list">
              {filtered.map((mg) => (
                <MessagingGroupCard key={mg.id} mg={mg} onRefresh={() => void load()} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
