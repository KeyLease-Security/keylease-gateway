import { CliError } from './errors.js';
import { TokenVerificationError } from './token.js';

/**
 * Machine-readable error response format when --json is set.
 * Emitted to stderr to keep stdout clean for parseable JSON output.
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

/**
 * Maps an error to a code for the error response.
 * Handles CliError, TokenVerificationError, and generic errors.
 */
function getErrorCode(error: unknown): string {
  if (error instanceof CliError) {
    return error.code;
  }
  if (error instanceof TokenVerificationError) {
    return error.code;
  }
  return 'internal_error';
}

/**
 * Maps an error to a hint message for the error response.
 * Only certain error codes warrant hints.
 */
function getErrorHint(error: unknown): string | undefined {
  if (error instanceof CliError) {
    // CliError codes that benefit from a usage hint
    if (
      error.code === 'parse_error' ||
      error.code === 'missing_option' ||
      error.code === 'invalid_option' ||
      error.code === 'unexpected_argument'
    ) {
      return 'run "keylease help" for usage';
    }
  }
  return undefined;
}

/**
 * Renders an error as a machine-readable JSON response when --json is set,
 * or as a human-readable error message otherwise.
 *
 * When json is true:
 * - Outputs JSON to stderr: { error: { code, message, hint? } }
 * - Keeps stdout clean
 *
 * When json is false:
 * - Outputs human-readable error to stderr
 * - Optionally includes hint
 */
export function renderError(
  error: unknown,
  io: { err(line?: string): void },
  json: boolean,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = getErrorCode(error);
  const hint = getErrorHint(error);

  if (json) {
    const response: ErrorResponse = {
      error: {
        code,
        message,
        ...(hint ? { hint } : {}),
      },
    };
    io.err(JSON.stringify(response));
  } else {
    io.err(`error: ${message}`);
    if (hint) {
      io.err(hint);
    }
  }
}
