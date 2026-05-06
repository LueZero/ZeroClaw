import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../store';
import { ThemeToggle } from '../components/ThemeToggle';

interface ContainerInfo {
  containerId: string;
  groupId: string;
  agentId: string;
  imageTag: string;
  host: string;
  port: number;
  protocol: string;
  activeSessions: number;
  maxSessions: number;
  status: string;
  createdAt: string;
  lastActivityAt: string;
}

interface DiagSession {
  sessionId: string;
  userId: string;
  userDisplayName: string;
  userRole: string;
  groupId: string;
  agentId: string;
  subAgent: string | null;
  platform: string;
  title: string | null;
  status: string;
  createdAt: string;
  lastMessageAt: string;
  dbMessageCount: number;
  actualMessageCount: number;
  userMessages: number;
  assistantMessages: number;
  missing: number;
  integrityOk: boolean;
}

interface DiagUserGroup {
  userId: string;
  displayName: string;
  role: string;
  sessionCount: number;
  totalDbMessages: number;
  totalActualMessages: number;
  totalMissing: number;
  sessions: DiagSession[];
}

interface DiagReport {
  summary: {
    totalUsers: number;
    totalSessions: number;
    sessionsWithIntegrityIssue: number;
    totalDbMessages: number;
    totalActualMessages: number;
    totalMissing: number;
  };
  users: DiagUserGroup[];
  sessions: DiagSession[];
}

export function AdminPage() {
  const api = useStore((s) => s.api);
  const setToken = useStore((s) => s.setToken);
  const userId = useStore((s) => s.userId);
  const role = useStore((s) => s.role);

  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);

  // 診斷報表
  const [diag, setDiag] = useState<DiagReport | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadContainers = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api<ContainerInfo[]>('/api/admin/containers');
      setContainers(list);
      setError(null);
      setErrorStatus(null);
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.message ?? '載入失敗');
      setErrorStatus(err.status ?? null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadDiag = useCallback(async () => {
    try {
      setDiagLoading(true);
      const r = await api<DiagReport>('/api/admin/diagnostics/sessions');
      setDiag(r);
      setDiagError(null);
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setDiagLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadContainers();
    loadDiag();
    const interval = setInterval(loadContainers, 10_000);
    return () => clearInterval(interval);
  }, [loadContainers, loadDiag]);

  const handleReload = async () => {
    setReloading(true);
    try {
      await api('/api/admin/reload', { method: 'POST' });
      await loadContainers();
    } finally {
      setReloading(false);
    }
  };

  const toggleUser = (uid: string) => {
    setExpandedUsers((m) => ({ ...m, [uid]: !m[uid] }));
  };

  /**
   * 刪除指定 session（admin 透過既有 DELETE /api/sessions/:id 執行）
   *
   * - SQLite 側：messages 表設有 ON DELETE CASCADE，會自動連帶刪除歷史訊息
   * - 後端：session-manager 會釋放容器、清除 sdkSession
   * - 前端：成功後重新載入診斷報表
   */
  const handleDeleteSession = async (sessionId: string, label: string) => {
    if (deletingId) return;
    const ok = window.confirm(
      `確定要刪除 session？\n\n  ${label}\n  ${sessionId}\n\n此動作不可還原（messages 也會一併刪除）。`,
    );
    if (!ok) return;
    setDeletingId(sessionId);
    try {
      await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      await loadDiag();
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : '刪除失敗');
    } finally {
      setDeletingId(null);
    }
  };

  /**
   * 批次刪除符合條件的 session（並聯呼叫 DELETE）。
   * 用於「清除過期」「清除完整性異常」「刪除某使用者全部 session」等情境。
   */
  const handleDeleteMany = async (targets: DiagSession[], label: string) => {
    if (targets.length === 0) return;
    const ok = window.confirm(
      `將刪除 ${targets.length} 個 session（${label}）。\n所有相關歷史訊息會一併移除。\n\n確定繼續？`,
    );
    if (!ok) return;
    setDeletingId('__batch__');
    try {
      // 每次最多並聯 5 個請求避免壓垮容器釋放邏輯
      const concurrency = 5;
      for (let i = 0; i < targets.length; i += concurrency) {
        const batch = targets.slice(i, i + concurrency);
        await Promise.all(
          batch.map((t) => api(`/api/sessions/${t.sessionId}`, { method: 'DELETE' })),
        );
      }
      await loadDiag();
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : '批次刪除失敗');
    } finally {
      setDeletingId(null);
    }
  };

  // 容器資料若拿到 403，理論上 App.tsx 已擋下，但保留防呆 UI
  const containersBlocked = errorStatus === 403;

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-title">
          <h1>ZeroClaw 管理後台</h1>
          <span className="admin-header-user">
            {userId} · <span className={`role-tag role-${role}`}>{role}</span>
          </span>
        </div>
        <div className="admin-header-actions">
          <a href="/admin/groups" className="btn btn-sm btn-primary">📦 Agent Groups</a>
          <a href="/admin/messaging-groups" className="btn btn-sm btn-primary">📡 Messaging Groups</a>
          <ThemeToggle />
          <a href="/chat" className="btn btn-sm btn-ghost">← 返回聊天</a>
          <button className="btn btn-sm btn-ghost" onClick={() => setToken(null)}>登出</button>
        </div>
      </header>

      <div className="admin-content">
        {/* ── 系統資訊 ── */}
        <section className="admin-section">
          <h2>系統概況</h2>
          <div className="admin-stats">
            <div className="admin-stat">
              <div className="admin-stat-value">{containers.length}</div>
              <div className="admin-stat-label">運行容器</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">
                {containers.reduce((sum, c) => sum + c.activeSessions, 0)}
              </div>
              <div className="admin-stat-label">活躍 Sessions</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">
                {new Set(containers.map((c) => c.groupId)).size}
              </div>
              <div className="admin-stat-label">活躍群組</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">{diag?.summary.totalUsers ?? '—'}</div>
              <div className="admin-stat-label">使用者總數</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">{diag?.summary.totalSessions ?? '—'}</div>
              <div className="admin-stat-label">Session 總數</div>
            </div>
            <div
              className={
                'admin-stat' +
                ((diag?.summary.sessionsWithIntegrityIssue ?? 0) > 0 ? ' admin-stat-warn' : '')
              }
            >
              <div className="admin-stat-value">
                {diag?.summary.sessionsWithIntegrityIssue ?? '—'}
              </div>
              <div className="admin-stat-label">完整性異常</div>
            </div>
          </div>
        </section>

        {/* ── 管理功能導覽 ── */}
        <section className="admin-section">
          <h2>管理功能</h2>
          <div className="admin-nav-cards">
            <a href="/admin/groups" className="admin-nav-card">
              <span className="admin-nav-card-icon">📦</span>
              <div className="admin-nav-card-body">
                <strong>Agent Groups</strong>
                <span className="admin-nav-card-desc">調整代理人群組顯示名稱、描述、啟用狀態（即時生效）</span>
              </div>
              <span className="admin-nav-card-arrow">→</span>
            </a>
            <a href="/admin/messaging-groups" className="admin-nav-card">
              <span className="admin-nav-card-icon">📡</span>
              <div className="admin-nav-card-body">
                <strong>Messaging Groups</strong>
                <span className="admin-nav-card-desc">管理通訊平台綁定、Wiring 配置、產生綁定 Code</span>
              </div>
              <span className="admin-nav-card-arrow">→</span>
            </a>
          </div>
        </section>

        {/* ── 容器監控 ── */}
        <section className="admin-section">
          <div className="admin-section-header">
            <h2>容器狀態</h2>
            <div className="admin-section-actions">
              <button className="btn btn-sm" onClick={loadContainers} disabled={loading}>
                🔄 重新整理
              </button>
              <button className="btn btn-sm btn-primary" onClick={handleReload} disabled={reloading}>
                {reloading ? '重載中…' : '⟳ 重載設定'}
              </button>
            </div>
          </div>

          {error && (
            <div className="admin-error">
              ⚠️ {error}
              {containersBlocked && (
                <div className="admin-error-hint">
                  目前角色 <code>{role}</code> 無權限。請以 admin 身份重新登入。
                </div>
              )}
            </div>
          )}

          {loading && containers.length === 0 ? (
            <div className="admin-empty">載入中…</div>
          ) : containers.length === 0 ? (
            <div className="admin-empty">目前沒有運行中的容器</div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>容器 ID</th>
                    <th>群組</th>
                    <th>代理</th>
                    <th>狀態</th>
                    <th>Sessions</th>
                    <th>協定</th>
                    <th>Port</th>
                    <th>最後活動</th>
                  </tr>
                </thead>
                <tbody>
                  {containers.map((c) => (
                    <tr key={c.containerId}>
                      <td className="mono">{c.containerId.slice(0, 20)}…</td>
                      <td>{c.groupId}</td>
                      <td>{c.agentId}</td>
                      <td>
                        <span className={`status-badge status-${c.status}`}>
                          {c.status}
                        </span>
                      </td>
                      <td>{c.activeSessions} / {c.maxSessions}</td>
                      <td className="mono">{c.protocol}</td>
                      <td className="mono">{c.port}</td>
                      <td>{new Date(c.lastActivityAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── 對話完整性診斷報表 ── */}
        <section className="admin-section">
          <div className="admin-section-header">
            <h2>對話完整性診斷</h2>
            <div className="admin-section-actions">
              <label className="admin-toggle">
                <input
                  type="checkbox"
                  checked={onlyIssues}
                  onChange={(e) => setOnlyIssues(e.target.checked)}
                />
                <span>僅顯示異常</span>
              </label>
              <button
                className="btn btn-sm btn-ghost"
                disabled={!diag || deletingId !== null}
                onClick={() =>
                  diag &&
                  handleDeleteMany(
                    diag.sessions.filter((s) => s.status === 'expired'),
                    '已過期',
                  )
                }
                title="刪除所有 status=expired 的 session"
              >
                清除已過期
              </button>
              <button
                className="btn btn-sm btn-ghost"
                disabled={!diag || deletingId !== null}
                onClick={() =>
                  diag &&
                  handleDeleteMany(
                    diag.sessions.filter((s) => !s.integrityOk),
                    '完整性異常',
                  )
                }
                title="刪除所有完整性異常的 session"
              >
                清除異常
              </button>
              <button className="btn btn-sm" onClick={loadDiag} disabled={diagLoading}>
                🔄 重新整理
              </button>
            </div>
          </div>

          {diagError && <div className="admin-error">⚠️ {diagError}</div>}

          {diag && (
            <>
              <div className="admin-diag-summary">
                <div className="admin-diag-summary-row">
                  <span>使用者：</span><strong>{diag.summary.totalUsers}</strong>
                  <span>Sessions：</span><strong>{diag.summary.totalSessions}</strong>
                  <span>DB 計數總和：</span><strong>{diag.summary.totalDbMessages}</strong>
                  <span>實際訊息：</span><strong>{diag.summary.totalActualMessages}</strong>
                  <span>遺漏：</span>
                  <strong className={diag.summary.totalMissing > 0 ? 'text-bad' : 'text-good'}>
                    {diag.summary.totalMissing}
                  </strong>
                </div>
                <p className="admin-diag-help">
                  <strong>DB 計數</strong>來自 <code>sessions.message_count</code>，
                  <strong>實際訊息</strong>為 <code>messages</code> 表內該 session 的紀錄數。
                  兩者不符（<strong>遺漏 &gt; 0</strong>）表示該 session 的對話歷史未完整保存。
                </p>
              </div>

              {diag.users.length === 0 ? (
                <div className="admin-empty">尚無任何使用者 / session 紀錄</div>
              ) : (
                <div className="admin-diag-users">
                  {diag.users
                    .filter((u) => !onlyIssues || u.totalMissing > 0)
                    .map((u) => {
                      const expanded = expandedUsers[u.userId] ?? u.totalMissing > 0;
                      const sessions = onlyIssues
                        ? u.sessions.filter((s) => !s.integrityOk)
                        : u.sessions;
                      return (
                        <div
                          key={u.userId}
                          className={
                            'admin-diag-user' + (u.totalMissing > 0 ? ' has-issue' : '')
                          }
                        >
                          <button
                            className="admin-diag-user-head"
                            onClick={() => toggleUser(u.userId)}
                          >
                            <span className="admin-diag-user-caret">
                              {expanded ? '▼' : '▶'}
                            </span>
                            <span className="admin-diag-user-name">{u.displayName}</span>
                            <span className={`role-tag role-${u.role}`}>{u.role}</span>
                            <span className="admin-diag-user-meta">
                              {u.sessionCount} sessions · DB {u.totalDbMessages} / 實際{' '}
                              {u.totalActualMessages}
                              {u.totalMissing > 0 && (
                                <span className="text-bad"> · 遺漏 {u.totalMissing}</span>
                              )}
                            </span>
                            <span
                              className="row-action-btn admin-diag-user-delete"
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteMany(u.sessions, `${u.displayName} 的全部 session`);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDeleteMany(
                                    u.sessions,
                                    `${u.displayName} 的全部 session`,
                                  );
                                }
                              }}
                              title="刪除此使用者的全部 session"
                            >
                              🗑 全部
                            </span>
                          </button>

                          {expanded && (
                            <div className="admin-table-wrap">
                              <table className="admin-table admin-table-compact">
                                <thead>
                                  <tr>
                                    <th>Session</th>
                                    <th>Agent</th>
                                    <th>狀態</th>
                                    <th>DB</th>
                                    <th>實際</th>
                                    <th>User</th>
                                    <th>Assistant</th>
                                    <th>遺漏</th>
                                    <th>完整性</th>
                                    <th>最後活動</th>
                                    <th>操作</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {sessions.map((s) => (
                                    <tr
                                      key={s.sessionId}
                                      className={s.integrityOk ? '' : 'row-bad'}
                                    >
                                      <td className="mono" title={s.sessionId}>
                                        {s.title ?? s.sessionId.slice(0, 12)}…
                                      </td>
                                      <td>
                                        {s.agentId}
                                        {s.subAgent && (
                                          <span className="sub-agent"> · {s.subAgent}</span>
                                        )}
                                      </td>
                                      <td>
                                        <span className={`status-badge status-${s.status}`}>
                                          {s.status}
                                        </span>
                                      </td>
                                      <td className="num">{s.dbMessageCount}</td>
                                      <td className="num">{s.actualMessageCount}</td>
                                      <td className="num">{s.userMessages}</td>
                                      <td className="num">{s.assistantMessages}</td>
                                      <td
                                        className={
                                          'num ' + (s.missing > 0 ? 'text-bad' : 'text-muted')
                                        }
                                      >
                                        {s.missing}
                                      </td>
                                      <td>
                                        {s.integrityOk ? (
                                          <span className="badge-good">✓ OK</span>
                                        ) : (
                                          <span className="badge-bad">✗ 不完整</span>
                                        )}
                                      </td>
                                      <td className="cell-time">
                                        {new Date(s.lastMessageAt).toLocaleString()}
                                      </td>
                                      <td>
                                        <button
                                          className="row-action-btn"
                                          disabled={deletingId === s.sessionId}
                                          onClick={() =>
                                            handleDeleteSession(
                                              s.sessionId,
                                              s.title ?? s.agentId,
                                            )
                                          }
                                          title="刪除此 session 與其全部訊息"
                                        >
                                          {deletingId === s.sessionId ? '刪除中…' : '🗑 刪除'}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

