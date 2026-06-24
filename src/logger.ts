/**
 * Minimal leveled logger with timestamps. Keeps console output readable and
 * also exposes a `child` prefix so each subsystem can tag its lines.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Allow DEBUG=1 to surface debug lines.
const MIN_LEVEL: Level =
  process.env.DEBUG === "1" || process.env.DEBUG === "true" ? "debug" : "info";

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: Level, prefix: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const tag = `[${ts()}] [${level.toUpperCase()}]${prefix ? ` ${prefix}` : ""}`;
  const sink = level === "error" ? console.error : console.log;
  sink(tag, ...args);
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  child: (prefix: string) => Logger;
}

export function createLogger(prefix = ""): Logger {
  return {
    debug: (...a) => emit("debug", prefix, a),
    info: (...a) => emit("info", prefix, a),
    warn: (...a) => emit("warn", prefix, a),
    error: (...a) => emit("error", prefix, a),
    child: (p) => createLogger(prefix ? `${prefix} ${p}` : p),
  };
}

export const logger = createLogger();
