import { ApiError } from "@tencent-connect/qqbot-nodejs";

/**
 * 统一错误模型：把 QQ 开放平台的错误码翻译成中文提示 + 处理建议。
 */

export type ErrorCategory =
  | "AUTH_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "PERMISSION_DENIED"
  | "INVALID_REQUEST"
  | "MEDIA_ERROR"
  | "GATEWAY_ERROR"
  | "UNKNOWN_ERROR";

export interface QQErrorDetail {
  source: "qq" | "app" | "client";
  code: number | string;
  type: ErrorCategory;
  message: string;
  retryable: boolean;
  suggestion: string;
  raw?: string;
}

export class AppError extends Error {
  readonly detail: QQErrorDetail;
  constructor(detail: QQErrorDetail) {
    super(detail.message);
    this.name = "AppError";
    this.detail = detail;
  }
}

interface CodeRule {
  type: ErrorCategory;
  message: string;
  suggestion: string;
  retryable: boolean;
}

const CODE_RULES: Record<number, CodeRule> = {
  10001: { type: "AUTH_ERROR", message: "AppID 或 AppSecret 错误", suggestion: "请核对凭证后重新连接", retryable: false },
  10003: { type: "AUTH_ERROR", message: "凭证无效", suggestion: "请核对凭证后重新连接", retryable: false },
  10004: { type: "AUTH_ERROR", message: "机器人不存在", suggestion: "请检查 AppID 是否正确", retryable: false },
  10006: { type: "AUTH_ERROR", message: "AppID 或 AppSecret 格式错误", suggestion: "请检查输入格式", retryable: false },
  100016: { type: "AUTH_ERROR", message: "AppID 或 AppSecret 错误", suggestion: "请到 QQ 开放平台核对凭证后重新连接", retryable: false },
  11001: { type: "PERMISSION_DENIED", message: "机器人尚未开通该接口权限", suggestion: "请到 QQ 开放平台为机器人开通对应的场景能力（群聊 / 私聊等）", retryable: false },
  22009: { type: "RATE_LIMIT", message: "消息发送超频", suggestion: "请稍后再试", retryable: true },
  40034104: { type: "RATE_LIMIT", message: "群消息发送频率受限", suggestion: "请稍后再试", retryable: true },
  40034090: { type: "PERMISSION_DENIED", message: "机器人没有 Markdown 权限", suggestion: "请改用普通文本消息", retryable: false },
  304082: { type: "MEDIA_ERROR", message: "富媒体资源拉取失败", suggestion: "请重新上传后再试", retryable: true },
  4914: { type: "PERMISSION_DENIED", message: "机器人未上线或 intents 权限不足", suggestion: "请到 QQ 开放平台完成机器人发布/上线，并为机器人申请对应消息权限", retryable: false },
  4915: { type: "PERMISSION_DENIED", message: "intents 未开通", suggestion: "请到开放平台为机器人申请对应消息权限", retryable: false },
};

/**
 * 提取 QQ 开放平台错误码。优先读取 SDK ApiError 的结构化字段
 * （bizCode / httpStatus），再退回从错误消息里正则提取。
 */
function extractCode(err: unknown): number | string | null {
  if (err instanceof ApiError) {
    if (typeof err.bizCode === "number") return err.bizCode;
    if (typeof err.httpStatus === "number") return err.httpStatus;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    for (const key of ["code", "bizCode", "err_code", "status", "retcode"]) {
      const c = obj[key];
      if (typeof c === "number" || typeof c === "string") return c;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/(?:code|retcode|err_code)[^0-9-]*(\d{4,})/i);
  if (m) return Number(m[1]);
  return null;
}

export function classifyError(err: unknown): QQErrorDetail {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const code = extractCode(err);
  if (code !== null && typeof code === "number" && CODE_RULES[code]) {
    const rule = CODE_RULES[code];
    return { source: "qq", code, type: rule.type, message: rule.message, retryable: rule.retryable, suggestion: rule.suggestion, raw };
  }
  const lower = raw.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { source: "app", code: code ?? "TIMEOUT", type: "TIMEOUT", message: "请求超时", retryable: true, suggestion: "请检查服务器到 QQ 开放平台的网络后重试", raw };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed") || lower.includes("network") || lower.includes("socket hang up")) {
    return { source: "app", code: code ?? "NETWORK", type: "NETWORK_ERROR", message: "网络连接失败", retryable: true, suggestion: "请检查服务器网络后重试", raw };
  }
  if (lower.includes("unauthorized") || lower.includes("401") || lower.includes("token")) {
    return { source: "qq", code: code ?? 401, type: "AUTH_ERROR", message: "凭证校验失败", suggestion: "请重新填写 AppID / AppSecret", retryable: false, raw };
  }
  if (typeof code === "number" && (code === 403 || code === 40030)) {
    return { source: "qq", code, type: "PERMISSION_DENIED", message: "没有操作权限", suggestion: "请到开放平台为机器人申请对应权限", retryable: false, raw };
  }
  // 结构化 ApiError 里若带了平台返回的业务错误信息，优先展示更精确的原文。
  if (err instanceof ApiError && err.bizMessage) {
    return {
      source: "qq",
      code: code ?? "API",
      type: code !== null && CODE_RULES[code as number] ? CODE_RULES[code as number].type : "UNKNOWN_ERROR",
      message: err.bizMessage,
      retryable: true,
      suggestion: "请到 QQ 开放平台确认机器人权限与配置",
      raw,
    };
  }
  const message = err instanceof Error ? err.message : "操作失败";
  return { source: "app", code: code ?? "UNKNOWN", type: "UNKNOWN_ERROR", message, retryable: true, suggestion: "请稍后重试", raw };
}

export function appError(type: ErrorCategory, message: string, suggestion: string, retryable = false): AppError {
  return new AppError({ source: "app", code: type, type, message, suggestion, retryable });
}

/** 序列化为 API 响应体。 */
export function errorBody(err: unknown): { success: false; error: QQErrorDetail } {
  const detail = err instanceof AppError ? err.detail : classifyError(err);
  return { success: false, error: detail };
}
