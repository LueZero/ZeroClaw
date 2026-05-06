import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { MessageBubble } from './MessageBubble';
import { ApprovalDialog } from './ApprovalDialog';
import { ElicitationDialog } from './ElicitationDialog';

export function ChatWindow() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const pendingElicitations = useStore((s) => s.pendingElicitations);
  const resolveApproval = useStore((s) => s.resolveApproval);
  const resolveElicitation = useStore((s) => s.resolveElicitation);

  const chatRef = useRef<HTMLDivElement>(null);
  const currentMessages = currentSessionId ? messages[currentSessionId] ?? [] : [];

  // 自動滾動到底部
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [currentMessages.length, streaming]);

  if (!currentSessionId) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-inner">
          <h3>ZeroClaw Control</h3>
          <p>從左側建立或選擇 Session，開始與代理協作。</p>
          <div className="chat-empty-grid">
            <div className="chat-empty-card">
              <strong className="mono">01</strong>
              <span>先建立新對話並選擇群組</span>
            </div>
            <div className="chat-empty-card">
              <strong className="mono">02</strong>
              <span>在輸入框下達任務並附加檔案</span>
            </div>
            <div className="chat-empty-card">
              <strong className="mono">03</strong>
              <span>追蹤工具呼叫與審批流程</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="chat" ref={chatRef}>
        {currentMessages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {streaming && <div className="streaming-indicator">● 回應中…</div>}
      </div>

      {pendingApprovals.map((a) => (
        <ApprovalDialog key={a.requestId} approval={a} onResolve={resolveApproval} />
      ))}
      {pendingElicitations.map((e) => (
        <ElicitationDialog key={e.requestId} elicitation={e} onResolve={resolveElicitation} />
      ))}
    </>
  );
}
