import { describe, it, expect } from 'vitest';
import { renderError, type ErrorResponse } from './error-renderer.js';
import { CliError } from './errors.js';
import { TokenVerificationError } from './token.js';

describe('renderError', () => {
  describe('JSON output', () => {
    it('renders CliError as JSON', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new CliError('missing required flag', 'missing_option', 2);

      renderError(error, io, true);

      expect(errors).toHaveLength(1);
      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.code).toBe('missing_option');
      expect(response.error.message).toBe('missing required flag');
      expect(response.error.hint).toBe('run "keylease help" for usage');
    });

    it('renders TokenVerificationError as JSON', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new TokenVerificationError('bad_signature', 'signature does not verify');

      renderError(error, io, true);

      expect(errors).toHaveLength(1);
      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.code).toBe('bad_signature');
      expect(response.error.message).toBe('signature does not verify');
      expect(response.error.hint).toBeUndefined();
    });

    it('renders generic errors as internal_error', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new Error('something went wrong');

      renderError(error, io, true);

      expect(errors).toHaveLength(1);
      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.code).toBe('internal_error');
      expect(response.error.message).toBe('something went wrong');
      expect(response.error.hint).toBeUndefined();
    });

    it('renders non-Error objects as internal_error', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };

      renderError('string error', io, true);

      expect(errors).toHaveLength(1);
      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.code).toBe('internal_error');
      expect(response.error.message).toBe('string error');
    });

    it('includes hint for parse_error', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new CliError('invalid syntax', 'parse_error', 2);

      renderError(error, io, true);

      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.hint).toBe('run "keylease help" for usage');
    });

    it('includes hint for invalid_option', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new CliError('invalid value', 'invalid_option', 2);

      renderError(error, io, true);

      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.hint).toBe('run "keylease help" for usage');
    });

    it('includes hint for unexpected_argument', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new CliError('unexpected arg', 'unexpected_argument', 2);

      renderError(error, io, true);

      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.hint).toBe('run "keylease help" for usage');
    });

    it('excludes hint for unknown_command', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new CliError('unknown command', 'unknown_command', 2);

      renderError(error, io, true);

      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.hint).toBeUndefined();
    });

    it('excludes hint for token errors', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new TokenVerificationError('token_expired', 'token has expired');

      renderError(error, io, true);

      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.hint).toBeUndefined();
    });
  });

  describe('Human-readable output', () => {
    it('renders CliError as plain text with hint', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new CliError('missing required flag', 'missing_option', 2);

      renderError(error, io, false);

      expect(errors).toEqual([
        'error: missing required flag',
        'run "keylease help" for usage',
      ]);
    });

    it('renders TokenVerificationError as plain text without hint', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new TokenVerificationError('bad_signature', 'signature does not verify');

      renderError(error, io, false);

      expect(errors).toEqual(['error: signature does not verify']);
    });

    it('renders generic errors without hint', () => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };
      const error = new Error('something went wrong');

      renderError(error, io, false);

      expect(errors).toEqual(['error: something went wrong']);
    });
  });

  describe('error codes', () => {
    const testCases: Array<[unknown, string]> = [
      [new CliError('msg', 'parse_error'), 'parse_error'],
      [new CliError('msg', 'missing_option'), 'missing_option'],
      [new CliError('msg', 'invalid_option'), 'invalid_option'],
      [new CliError('msg', 'unexpected_argument'), 'unexpected_argument'],
      [new CliError('msg', 'unknown_command'), 'unknown_command'],
      [new TokenVerificationError('malformed_token', 'msg'), 'malformed_token'],
      [new TokenVerificationError('unsupported_version', 'msg'), 'unsupported_version'],
      [new TokenVerificationError('invalid_consumer', 'msg'), 'invalid_consumer'],
      [new TokenVerificationError('bad_signature', 'msg'), 'bad_signature'],
      [new TokenVerificationError('consumer_mismatch', 'msg'), 'consumer_mismatch'],
      [new TokenVerificationError('lease_mismatch', 'msg'), 'lease_mismatch'],
      [new TokenVerificationError('token_expired', 'msg'), 'token_expired'],
      [new TokenVerificationError('token_not_yet_valid', 'msg'), 'token_not_yet_valid'],
    ];

    it.each(testCases)('maps error %s to code %s', (error, expectedCode) => {
      const errors: string[] = [];
      const io = { err: (line?: string) => errors.push(line ?? '') };

      renderError(error, io, true);

      const response = JSON.parse(errors[0]) as ErrorResponse;
      expect(response.error.code).toBe(expectedCode);
    });
  });
});
