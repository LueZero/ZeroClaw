import { useState } from 'react';
import { useStore } from '../store';
import { ThemeToggle } from '../components/ThemeToggle';

export function LoginPage() {
  const setToken = useStore((s) => s.setToken);
  const [userId, setUserId] = useState(() => `user-${Math.random().toString(36).slice(2, 8)}`);
  const [role, setRole] = useState<'admin' | 'member'>('admin');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      });
      const { token } = await res.json();
      setToken(token);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-theme-toggle">
        <ThemeToggle />
      </div>

      <div className="login-shell">
        <section className="login-panel login-panel-info">
          <div className="login-brand">
            <span className="login-brand-mark" aria-hidden="true" />
            <h2>ZeroClaw</h2>
          </div>
          <p className="login-sub">Ops Console for Multi-Agent Runtime</p>

          <div className="login-feature-grid">
            <article className="login-feature-card">
              <h3>Real-time Orchestration</h3>
              <p>同時監控 Session 狀態、代理切換、工具呼叫與回應串流。</p>
            </article>
            <article className="login-feature-card">
              <h3>Approval Gate</h3>
              <p>高風險工具呼叫先審批，安全流程可視化，降低誤操作風險。</p>
            </article>
            <article className="login-feature-card">
              <h3>Cross-SDK Diagnostics</h3>
              <p>整合 Copilot 與 OpenCode 執行紀錄，快速追查完整性異常。</p>
            </article>
          </div>
        </section>

        <form className="login-panel login-panel-form" onSubmit={submit}>
          <h3>Developer Login</h3>
          <p className="login-form-sub">以測試身份進入控制台</p>

          <label className="field-label" htmlFor="login-user-id">User ID</label>
          <input
            id="login-user-id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="user-xxxxxx"
          />

          <label className="field-label" htmlFor="login-role">Role</label>
          <select
            id="login-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
          >
            <option value="admin">Admin（可進入後台）</option>
            <option value="member">Member</option>
          </select>

          <button className="btn btn-primary login-submit" disabled={busy}>
            {busy ? '登入中…' : '進入作業台'}
          </button>
        </form>
      </div>
    </div>
  );
}
