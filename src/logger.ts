import { redact, safeErrorMessage } from "./redaction.ts";
import type { V2Config } from "./config.ts";

const LEVELS = { silent: 99, error: 40, warn: 30, info: 20, debug: 10 } as const;

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: V2Config["logLevel"] = "info", sink: (line: string) => void = console.error): Logger {
  const threshold = LEVELS[level];
  const write = (name: keyof typeof LEVELS, event: string, fields?: Record<string, unknown>) => {
    if (LEVELS[name] < threshold) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: name, event, ...(redact(fields || {}) as Record<string, unknown>) }));
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export function errorFields(error: unknown): Record<string, string> {
  return { error: safeErrorMessage(error) };
}
