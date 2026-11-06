type Level = "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS = [
  /("?(?:appSecret|clientSecret|access_token|secret|secretEnc)"?\s*[:=]\s*"?)[A-Za-z0-9\-_.+/=]{6,}("?)/gi,
  /(Bearer\s+)[A-Za-z0-9\-_.]{8,}/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "$1***$2");
  return out;
}

function currentLevel(): number {
  const lvl = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
  return LEVEL_NUM[lvl] ?? LEVEL_NUM.info;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (LEVEL_NUM[level] < currentLevel()) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${redactSecrets(msg)}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) {
    // extra 里的错误/对象可能携带 AppSecret，输出前同样脱敏。
    const extraText =
      extra instanceof Error
        ? (extra.stack ?? extra.message)
        : typeof extra === "string"
          ? extra
          : safeStringify(extra);
    fn(line, redactSecrets(extraText));
  } else {
    fn(line);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};

/** 供 SDK 使用的 logger 适配器。 */
export const sdkLogger = {
  debug: (...args: unknown[]) => log.debug(args.map(String).join(" ")),
  info: (...args: unknown[]) => log.info(args.map(String).join(" ")),
  warn: (...args: unknown[]) => log.warn(args.map(String).join(" ")),
  error: (...args: unknown[]) => log.error(args.map(String).join(" ")),
};
