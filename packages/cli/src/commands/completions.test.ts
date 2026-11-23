import { describe, expect, it } from 'vitest';
import {
  COMPLETION_COMMANDS,
  COMPLETION_FLAGS,
  COMPLETION_NETWORKS,
  COMPLETION_SHELLS,
  FLAG_DESCRIPTIONS,
  renderCompletions,
  type CompletionShell,
} from './completions.js';
import { CliError, parseArgv, renderHelp, run, type CliIo } from '../index.js';

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line = '') => out.push(line),
      err: (line = '') => err.push(line),
    },
  };
}

/** Commands documented in the help output, e.g. `keylease acquire --service …`. */
function documentedCommands(help: string): string[] {
  return [...help.matchAll(/^ {2}keylease (\w+)/gm)].map((match) => match[1] as string);
}

/** Every long option mentioned anywhere in the help output. */
function documentedOptions(help: string): string[] {
  return [...new Set([...help.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0]))].sort();
}

describe('documented command and flag table', () => {
  it('covers every command and option the help output documents', () => {
    const help = renderHelp();
    const commands = documentedCommands(help);
    const options = documentedOptions(help);

    expect(commands.length).toBeGreaterThanOrEqual(8);
    expect(options).toContain('--dry-run');
    expect(options).toContain('--check-chain');

    for (const command of commands) {
      expect(COMPLETION_COMMANDS.map((entry) => entry.name)).toContain(command);
    }
    for (const option of options) {
      expect(COMPLETION_FLAGS).toContain(option);
    }
  });

  it('gives every completion flag a description', () => {
    for (const flag of COMPLETION_FLAGS) {
      expect(FLAG_DESCRIPTIONS[flag], `missing description for ${flag}`).toBeDefined();
    }
  });
});

describe('renderCompletions', () => {
  it('mentions every documented command and option in each shell script', () => {
    const help = renderHelp();
    const commands = documentedCommands(help);
    const options = documentedOptions(help);

    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletions(shell);
      for (const command of commands) {
        expect(script, `${shell} script should mention "${command}"`).toContain(command);
      }
      for (const option of options) {
        expect(script, `${shell} script should mention "${option}"`).toContain(option);
        if (shell === 'fish') {
          expect(script, `${shell} script should complete ${option}`).toContain(
            `-l ${option.slice(2)}`,
          );
        }
      }
      for (const network of COMPLETION_NETWORKS) {
        expect(script, `${shell} script should offer ${network}`).toContain(network);
      }
    }
  });

  it('renders an installable script per shell', () => {
    const bash = renderCompletions('bash');
    expect(bash).toContain('source <(keylease completions bash)');
    expect(bash).toContain('complete -F _keylease_completions keylease');
    expect(bash).toContain('--network) COMPREPLY=');

    const zsh = renderCompletions('zsh');
    expect(zsh.startsWith('#compdef keylease')).toBe(true);
    expect(zsh).toContain('--network[network name]:network:(testnet mainnet local)');

    const fish = renderCompletions('fish');
    expect(fish).toContain("-f -n '__fish_use_subcommand' -a acquire");
    expect(fish).toContain("-l network -x -a 'testnet mainnet local'");
    expect(fish).toContain("-n '__fish_seen_subcommand_from completions' -x -a 'bash zsh fish'");
  });

  it('ends every script with a newline-free body for the io layer to terminate', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletions(shell);
      expect(script.length).toBeGreaterThan(0);
      expect(script.endsWith('\n')).toBe(false);
    }
  });
});

describe('completions command', () => {
  it('parses a supported shell', () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(parseArgv(['completions', shell])).toEqual({
        command: 'completions',
        args: { shell: shell as CompletionShell },
      });
    }
    expect(parseArgv(['completions', 'bash', '--help'])).toEqual({ command: 'help' });
  });

  it('rejects an unknown shell with a usage error listing the supported ones', () => {
    let error: unknown;
    try {
      parseArgv(['completions', 'powershell']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('usage_error');
    expect((error as CliError).exitCode).toBe(2);
    expect((error as CliError).message).toContain('unsupported shell "powershell"');
    for (const shell of COMPLETION_SHELLS) {
      expect((error as CliError).message).toContain(shell);
    }
  });

  it('requires a shell argument', () => {
    expect(() => parseArgv(['completions'])).toThrow(/requires a shell/);
    expect(() => parseArgv(['completions', 'bash', 'zsh'])).toThrow(/unexpected argument/);
  });

  it('prints the script on stdout', async () => {
    const { io, out, err } = captureIo();
    expect(await run(['completions', 'bash'], io, { cwd: '/' })).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('_keylease_completions');

    const unknown = captureIo();
    expect(await run(['completions', 'tcsh'], unknown.io, { cwd: '/' })).toBe(2);
    expect(unknown.err.join('\n')).toContain('unsupported shell');
    expect(unknown.out).toEqual([]);
  });
});
