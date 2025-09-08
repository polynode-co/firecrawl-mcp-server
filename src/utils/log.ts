export type LogLevel =
  | 'error'
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'critical'
  | 'alert'
  | 'emergency';

export function safeLog(level: LogLevel, data: any, scope?: string): void {
  try {
    const prefix = scope ? `[${scope}]` : '';
    const message = `${prefix}[${level}] ${
      typeof data === 'object' ? JSON.stringify(data) : String(data)
    }`;
    if (level === 'warning') {
      console.warn(message);
    } else if (
      level === 'error' ||
      level === 'critical' ||
      level === 'alert' ||
      level === 'emergency'
    ) {
      console.error(message);
    } else {
      console.log(message);
    }
  } catch (_) {
    // ignore logging failures
  }
}
