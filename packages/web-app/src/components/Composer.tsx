import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';

export function Composer() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const streaming = useStore((s) => s.streaming);
  const sendUserMessage = useStore((s) => s.sendUserMessage);
  const abort = useStore((s) => s.abort);

  const [input, setInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<File[]>([]);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto'; // Reset height temporarily to correctly compute scrollHeight
      const nextHeight = Math.min(textarea.scrollHeight, 240); // Max 240px
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > 240 ? 'auto' : 'hidden';
    }
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!input.trim() || !currentSessionId) return;
      sendUserMessage(input.trim());
      setInput('');
      setAttachments([]);
      
      // Request next frame to let React update the value first
      requestAnimationFrame(() => adjustTextareaHeight());
    },
    [input, currentSessionId, sendUserMessage, adjustTextareaHeight],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      setAttachments((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
    }
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  return (
    <form
      className="composer"
      onSubmit={handleSubmit}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((f, i) => (
            <span key={i} className="composer-file">
              📎 {f.name}
              <button type="button" onClick={() => removeAttachment(i)} className="composer-file-rm">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <button
          type="button"
          className="btn composer-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!currentSessionId}
          title="附加檔案"
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={currentSessionId ? '輸入訊息… (Shift+Enter 換行)' : '請先選擇或建立 Session'}
          disabled={!currentSessionId}
          rows={1}
        />
        {streaming ? (
          <button type="button" className="btn btn-danger" onClick={abort}>停止</button>
        ) : (
          <button className="btn btn-primary" disabled={!currentSessionId || !input.trim()}>送出任務</button>
        )}
      </div>
      <div className="composer-hint mono">
        Enter 送出 · Shift + Enter 換行 · 可拖放檔案到輸入區
      </div>
    </form>
  );
}
