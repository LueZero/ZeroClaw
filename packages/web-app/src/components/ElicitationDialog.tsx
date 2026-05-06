import { useState } from 'react';
import type { ElicitationRequest } from '../store';

interface Props {
  elicitation: ElicitationRequest;
  onResolve: (requestId: string, answer: string) => void;
}

export function ElicitationDialog({ elicitation, onResolve }: Props) {
  const [input, setInput] = useState('');

  function submit() {
    const answer = input.trim();
    if (!answer) return;
    onResolve(elicitation.requestId, answer);
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>❓ 請回答</h3>
        <p className="modal-desc">{elicitation.question}</p>

        {elicitation.options && elicitation.options.length > 0 ? (
          <div className="modal-options">
            {elicitation.options.map((opt) => (
              <button
                key={opt}
                className="btn btn-option"
                onClick={() => onResolve(elicitation.requestId, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : null}

        <div className="modal-input-row">
          <input
            className="modal-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="輸入回答…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button className="btn btn-primary" onClick={submit} disabled={!input.trim()}>
            送出
          </button>
        </div>
      </div>
    </div>
  );
}
