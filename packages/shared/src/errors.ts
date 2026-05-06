/**
 * 平台統一錯誤類別與錯誤碼
 */

export const ErrorCodes = {
  // 認證 / 授權
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // 配置
  CONFIG_INVALID: 'CONFIG_INVALID',
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_DETECTION_FAILED: 'AGENT_DETECTION_FAILED',

  // Session
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_LIMIT_EXCEEDED: 'SESSION_LIMIT_EXCEEDED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',

  // 容器
  CONTAINER_LAUNCH_FAILED: 'CONTAINER_LAUNCH_FAILED',
  CONTAINER_UNHEALTHY: 'CONTAINER_UNHEALTHY',
  IMAGE_BUILD_FAILED: 'IMAGE_BUILD_FAILED',

  // SDK / Runtime
  SDK_ERROR: 'SDK_ERROR',
  RUNTIME_TIMEOUT: 'RUNTIME_TIMEOUT',
  RUNTIME_ABORTED: 'RUNTIME_ABORTED',

  // 通訊平台
  PLATFORM_ERROR: 'PLATFORM_ERROR',
  WEBHOOK_INVALID: 'WEBHOOK_INVALID',

  // 通用
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class PlatformError extends Error {
  override readonly name = 'PlatformError';

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

// 常用錯誤工廠
export const Errors = {
  unauthorized: (msg = 'Unauthorized') =>
    new PlatformError(ErrorCodes.UNAUTHORIZED, msg, 401),
  forbidden: (msg = 'Forbidden') =>
    new PlatformError(ErrorCodes.FORBIDDEN, msg, 403),
  notFound: (resource: string, id: string) =>
    new PlatformError(ErrorCodes.NOT_FOUND, `${resource} not found: ${id}`, 404, { resource, id }),
  groupNotFound: (id: string) =>
    new PlatformError(ErrorCodes.GROUP_NOT_FOUND, `Group not found: ${id}`, 404, { groupId: id }),
  agentNotFound: (id: string) =>
    new PlatformError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${id}`, 404, { agentId: id }),
  sessionNotFound: (id: string) =>
    new PlatformError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${id}`, 404, {
      sessionId: id,
    }),
  validation: (msg: string, details?: Record<string, unknown>) =>
    new PlatformError(ErrorCodes.VALIDATION_ERROR, msg, 400, details),
  configInvalid: (msg: string, details?: Record<string, unknown>) =>
    new PlatformError(ErrorCodes.CONFIG_INVALID, msg, 500, details),
  containerLaunchFailed: (msg: string, details?: Record<string, unknown>) =>
    new PlatformError(ErrorCodes.CONTAINER_LAUNCH_FAILED, msg, 500, details),
};
