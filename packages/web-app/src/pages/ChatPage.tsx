import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from '../store';
import { GroupList } from '../components/GroupList';
import { SessionList } from '../components/SessionList';
import { NewSessionButton } from '../components/NewSessionButton';
import { AgentSelector } from '../components/AgentSelector';
import { ChatWindow } from '../components/ChatWindow';
import { Composer } from '../components/Composer';
import { ThemeToggle } from '../components/ThemeToggle';

export function ChatPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const selectSession = useStore((s) => s.selectSession);
  const loadGroups = useStore((s) => s.loadGroups);
  const loadSessions = useStore((s) => s.loadSessions);
  const setToken = useStore((s) => s.setToken);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessions = useStore((s) => s.sessions);
  const groups = useStore((s) => s.groups);
  const messages = useStore((s) => s.messages);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const currentMessages = currentSessionId ? messages[currentSessionId] ?? [] : [];

  useEffect(() => {
    loadGroups();
    loadSessions();
  }, [loadGroups, loadSessions]);

  // URL 中有 sessionId → 自動選取
  useEffect(() => {
    if (sessionId) {
      selectSession(sessionId);
    }
  }, [sessionId, selectSession]);

  // 選取 session 時自動收起手機 sidebar
  const handleSelectSession = () => {
    setSidebarOpen(false);
  };

  return (
    <div className="app">
      {/* 手機遮罩 */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar-header">
          <strong>ZeroClaw</strong>
          <div className="sidebar-header-actions">
            <ThemeToggle />
            <a href="/admin" className="btn btn-sm btn-ghost">管理</a>
            <button className="btn btn-sm btn-ghost" onClick={() => setToken(null)}>登出</button>
            <button className="btn btn-sm btn-ghost sidebar-close-btn" onClick={() => setSidebarOpen(false)}>✕</button>
          </div>
        </div>
        <NewSessionButton />
        <div className="sidebar-scroll" onClick={handleSelectSession}>
          <SessionList />
          <GroupList />
        </div>
      </aside>

      <main className="main">
        <div className="chat-header">
          <button className="btn btn-sm sidebar-toggle" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          {currentSession ? (
            <>
              <div className="chat-header-info">
                <span className="chat-header-kicker mono">ACTIVE SESSION</span>
                <span className="chat-header-agent">{currentSession.title ?? currentSession.agentId}</span>
                <span className="chat-header-id mono">{currentSession.sessionId.slice(0, 8)}</span>
                <span className={`session-status-dot ${currentSession.status}`} title={currentSession.status} />
              </div>
              <div className="chat-header-metrics">
                <span className="metric-pill">
                  <span className="metric-pill-label mono">msgs</span>
                  <strong>{currentMessages.length}</strong>
                </span>
                <span className="metric-pill">
                  <span className="metric-pill-label mono">sessions</span>
                  <strong>{sessions.length}</strong>
                </span>
                <span className="metric-pill">
                  <span className="metric-pill-label mono">groups</span>
                  <strong>{groups.length}</strong>
                </span>
              </div>
            </>
          ) : (
            <div className="chat-header-info">
              <span className="chat-header-kicker mono">ZEROCLAW NODE</span>
              <span className="chat-header-agent">準備建立新作業對話</span>
            </div>
          )}
        </div>

        <section className="chat-stage">
          <AgentSelector />
          <ChatWindow />
          <Composer />
        </section>
      </main>
    </div>
  );
}
