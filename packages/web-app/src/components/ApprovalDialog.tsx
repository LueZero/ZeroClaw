import { useState } from 'react';
import type { ApprovalRequest } from '../store';

interface Props {
  approval: ApprovalRequest;
  onResolve: (requestId: string, approved: boolean) => void;
}

export function ApprovalDialog({ approval, onResolve }: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>🔐 需要核准</h3>
        <p className="modal-desc">{approval.description}</p>

        <div className="modal-detail">
          <strong>工具：</strong>
          <code>{approval.tool}</code>
        </div>

        <div className="modal-detail">
          <strong>參數：</strong>
          <pre className="modal-pre">
            {JSON.stringify(approval.args, null, 2)}
          </pre>
        </div>

        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={() => onResolve(approval.requestId, true)}
          >
            ✅ 核准
          </button>
          <button
            className="btn btn-danger"
            onClick={() => onResolve(approval.requestId, false)}
          >
            ❌ 拒絕
          </button>
        </div>
      </div>
    </div>
  );
}
