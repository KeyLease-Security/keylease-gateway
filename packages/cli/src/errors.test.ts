import { describe, expect, it } from 'vitest';
import { redactToken } from './errors.js';

describe('redactToken', () => {
  it('redacts a valid session token', () => {
    const token = 'kls1.eyJ2IjoxLCJsZWFzZV9pZCI6IjEiLCJjb25zdW1lciI6IkdER0tNR1VHRFpRS1k2WUhBNVo2QVkyRzRYRFN6UFN6M1NXNVVOMzNBUlZNTzZRU1JEV1A1WUxFWCIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDA3MjAwfQ.dGVzdHNpZ25hdHVyZQ';
    expect(redactToken(token)).toBe('kls1.<redacted>');
  });

  it('redacts multiple tokens in a single string', () => {
    const token1 = 'kls1.payload1.sig1';
    const token2 = 'kls1.payload2.sig2';
    const text = `Token 1: ${token1}, Token 2: ${token2}`;
    const redacted = redactToken(text);
    expect(redacted).toBe('Token 1: kls1.<redacted>, Token 2: kls1.<redacted>');
    expect(redacted).not.toContain('payload1');
    expect(redacted).not.toContain('payload2');
  });

  it('redacts tokens in error messages', () => {
    const token = 'kls1.abc123.def456';
    const errorMessage = `Failed to verify token ${token}: signature mismatch`;
    const redacted = redactToken(errorMessage);
    expect(redacted).toBe('Failed to verify token kls1.<redacted>: signature mismatch');
    expect(redacted).not.toContain('abc123');
  });

  it('handles edge cases with similar patterns', () => {
    const text = 'kls1.abc.def and kls2.abc.def and kls1.abc.def';
    const redacted = redactToken(text);
    expect(redacted).toBe('kls1.<redacted> and kls2.abc.def and kls1.<redacted>');
  });

  it('does not redact empty strings', () => {
    expect(redactToken('')).toBe('');
  });

  it('does not redact strings without tokens', () => {
    const text = 'This is a normal error message without tokens';
    expect(redactToken(text)).toBe(text);
  });

  it('redacts tokens with special base64url characters', () => {
    const token = 'kls1.abc-_XYZ.123-_456';
    expect(redactToken(token)).toBe('kls1.<redacted>');
  });
});
