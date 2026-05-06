import { useStore } from '../store';

export function SettingsPage() {
  const setToken = useStore((s) => s.setToken);

  return (
    <div className="settings-page">
      <header className="admin-header">
        <h1>⚙️ 設定</h1>
        <div className="admin-header-actions">
          <a href="/chat" className="btn btn-sm">← 返回聊天</a>
          <button className="btn btn-sm" onClick={() => setToken(null)}>登出</button>
        </div>
      </header>

      <div className="admin-content">
        <section className="admin-section">
          <h2>個人偏好</h2>
          <p style={{ color: '#888' }}>未來版本將支援：主題色彩、通知設定、語言切換等。</p>
        </section>
      </div>
    </div>
  );
}
