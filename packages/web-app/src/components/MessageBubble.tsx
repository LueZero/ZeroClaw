import type { ChatMessage } from '../store';
import { ToolCallCard } from './ToolCallCard';

interface Props {
  message: ChatMessage;
}

/** Render **bold** and `code` in plain text */
function renderInlineMarkup(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1]) parts.push(<strong key={key++}>{match[1]}</strong>);
    if (match[2]) parts.push(<code key={key++} className="inline-code">{match[2]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function isSystemNotice(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    (message.id.startsWith('subagent-') ||
      message.id.startsWith('switch-'))
  );
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isNotice = isSystemNotice(message);

  if (isNotice) {
    return (
      <div className="msg-notice">
        <span className="msg-notice-text">{renderInlineMarkup(message.content)}</span>
      </div>
    );
  }

  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-head">
        <span className="msg-role mono">{isUser ? 'YOU' : 'AGENT'}</span>
        {!isUser && message.agentId && (
          <span className="msg-agent mono">{message.agentId}</span>
        )}
      </div>
      <div className="msg-content">{renderInlineMarkup(message.content)}</div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallCard toolCalls={message.toolCalls} />
      )}
    </div>
  );
}
