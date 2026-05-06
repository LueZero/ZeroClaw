/**
 * Stub adapters — 各平台已有獨立實作檔案，此檔僅保留 re-export 供向後相容。
 * 實際 adapter 請使用各自的 create*Adapter 函式。
 */

export { createDiscordAdapter } from './discord-adapter.js';
export { createSlackAdapter } from './slack-adapter.js';
export { createTeamsAdapter } from './teams-adapter.js';
export { createWhatsAppAdapter as createWhatsappAdapter } from './whatsapp-adapter.js';

