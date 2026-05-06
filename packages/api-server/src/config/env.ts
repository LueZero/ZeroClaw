import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  // 路徑
  AGENTS_DIR: z.string().default('./agents'),
  GROUPS_FILE: z.string().default('./groups.yaml'),
  DATA_DIR: z.string().default('./data'),

  // 資料庫
  DATABASE_URL: z.string().optional(), // e.g. postgres://...
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('postgres'),
  SQLITE_PATH: z.string().default('./data/platform.db'),

  // 認證
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-please-32chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Docker
  DOCKER_SOCKET: z.string().optional(), // 預設: unix /var/run/docker.sock 或 windows named pipe
  DOCKER_NETWORK: z.string().default('zeroclaw-net'),
  // 宿主機上 agents 目錄的絕對路徑（Docker bind mount 需要 host path）
  // Docker-in-Docker 場景：API server 在容器內，但 Docker daemon 在宿主機
  HOST_AGENTS_DIR: z.string().optional(),

  // 各通道憑證（任一可選）
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /** Telegram 連線模式：polling（預設，不需要公開 URL）或 webhook */
  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_APP_ID: z.string().optional(),
  DISCORD_BOT_ID: z.string().optional(),
  DISCORD_MODE: z.enum(['gateway', 'webhook']).default('webhook'),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_MODE: z.enum(['socket', 'webhook']).default('webhook'),
  // Microsoft Teams （Azure App Registration + Azure Bot resource）
  TEAMS_APP_ID: z.string().optional(),
  TEAMS_APP_PASSWORD: z.string().optional(),
  TEAMS_APP_TENANT_ID: z.string().optional(),

  // SDK / 模型
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),

  // BYOK — Copilot SDK 使用自有 OpenAI-compatible provider（繞過 Copilot quota）
  BYOK_MODEL: z.string().default('gpt-5-mini'),
  BYOK_BASE_URL: z.string().default('https://api.openai.com/v1'),

  // Opencode auth — 宿主機上 opencode auth.json 所在目錄的絕對路徑
  // 容器啟動時會掛載到 /root/.local/share/opencode/:ro
  // 使用者需先在宿主機執行 `opencode providers login` 取得認證
  OPENCODE_AUTH_DIR: z.string().optional(),

  // Opencode runtime 預設 model/provider（可由 group.container.env 覆蓋）
  OPENCODE_MODEL_ID: z.string().default('anthropic/claude-sonnet-4-20250514'),
  OPENCODE_PROVIDER_ID: z.string().default('anthropic'),

  // 容器資源
  DEFAULT_CONTAINER_CPUS: z.string().default('1.0'),
  DEFAULT_CONTAINER_MEMORY: z.string().default('512m'),
  CONTAINER_IDLE_TIMEOUT_SEC: z.coerce.number().int().positive().default(1800),

  // Session 生命週期 (T-3)
  /** 每用戶最多可同時持有的 active session 數量（0 = 不限） */
  MAX_SESSIONS_PER_USER: z.coerce.number().int().nonnegative().default(20),
  /** Session 閒置超時秒數（最後一則訊息後無活動 → 自動結束；0 = 不限） */
  SESSION_IDLE_TIMEOUT_SEC: z.coerce.number().int().nonnegative().default(1800),
  /** 單 session 最大訊息數（含 user + assistant；超過自動結束；0 = 不限） */
  SESSION_MAX_MESSAGES: z.coerce.number().int().nonnegative().default(200),
  /** 歷史 session 保留天數（超過 cron 清理；0 = 永久保留） */
  SESSION_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),

  // 日誌
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
