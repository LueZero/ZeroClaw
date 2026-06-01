import { Component, type ReactNode, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store';
import { LoginPage } from './pages/LoginPage';
import { ChatPage } from './pages/ChatPage';
import { AdminPage } from './pages/AdminPage';
import { SettingsPage } from './pages/SettingsPage';
import { MessagingGroupsPage } from './pages/MessagingGroupsPage';
import { GroupsAdminPage } from './pages/GroupsAdminPage';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'system-ui' }}>
          <h2>發生錯誤</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#c00' }}>{this.state.error.message}</pre>
          <button onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ marginTop: 12, padding: '8px 16px', cursor: 'pointer' }}>
            重新載入
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const token = useStore((s) => s.token);
  const role = useStore((s) => s.role);
  const connectWs = useStore((s) => s.connectWs);

  // Global WS connection — stays alive across all page navigations
  useEffect(() => {
    if (token) connectWs();
  }, [token, connectWs]);

  if (!token) return <LoginPage />;

  return (
    <ErrorBoundary>
      <BrowserRouter>
      <Routes>
        <Route path="/chat/:sessionId?" element={<ChatPage />} />
        <Route
          path="/admin"
          element={role === 'admin' ? <AdminPage /> : <NotAdmin />}
        />
        <Route
          path="/admin/messaging-groups"
          element={role === 'admin' ? <MessagingGroupsPage /> : <NotAdmin />}
        />
        <Route
          path="/admin/groups"
          element={role === 'admin' ? <GroupsAdminPage /> : <NotAdmin />}
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}

function NotAdmin() {
  const setToken = useStore((s) => s.setToken);
  const role = useStore((s) => s.role);
  const userId = useStore((s) => s.userId);
  return (
    <div className="forbidden-page">
      <div className="forbidden-card">
        <div className="forbidden-icon">🛡️</div>
        <h2>需要管理員權限</h2>
        <p className="forbidden-desc">
          後台管理頁面僅限 <strong>admin</strong> 角色存取。
        </p>
        <p className="forbidden-meta">
          目前身份：<code>{userId ?? '—'}</code>（{role ?? 'unknown'}）
        </p>
        <div className="forbidden-actions">
          <a href="/chat" className="btn">← 回聊天</a>
          <button className="btn btn-primary" onClick={() => setToken(null)}>
            以 Admin 身份重新登入
          </button>
        </div>
      </div>
    </div>
  );
}

