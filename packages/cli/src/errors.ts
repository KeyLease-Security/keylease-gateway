/** A CLI usage, configuration or validation error with a stable code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = 'usage_error', exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * Redacts session bearer tokens from error messages to prevent leaking
 * credentials in logs and terminal output.
 *
 * Replaces `kls1.<...>` with `kls1.<redacted>`.
 */
export function redactToken(text: string): string {
  return text.replace(/kls1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'kls1.<redacted>');
}
