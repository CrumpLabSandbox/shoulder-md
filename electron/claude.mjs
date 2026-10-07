// Runs the user's own Claude Code to propose edits for one document. The app holds no
// credentials and signs nobody in: it starts the `claude` program already installed on this
// Mac, which uses whatever account that program is signed in with. Without it, the feature is
// simply unavailable.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED_TOOLS, eventsFromLine, proposalPrompt, takeLines } from './claude-events.mjs';

const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, ...opts }, (error, stdout) =>
      resolve(error ? '' : String(stdout).trim()),
    );
  });

let shellPath;
/** The PATH of a login shell. An app started from the Finder gets a bare one, without node. */
async function loginPath() {
  if (shellPath === undefined) {
    const out = await run(process.env.SHELL || '/bin/zsh', ['-lic', 'echo "__PATH__$PATH"']);
    shellPath = /__PATH__(.*)/.exec(out)?.[1] || process.env.PATH || '';
  }
  return shellPath;
}

/** Where Claude Code is installed, if it is. */
export async function findClaude() {
  if (process.env.SHOULDER_CLAUDE_BIN) return process.env.SHOULDER_CLAUDE_BIN;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const dir of (await loginPath()).split(':'))
    if (dir) candidates.push(path.join(dir, 'claude'));
  for (const c of candidates) {
    try {
      await fs.access(c, fs.constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export async function claudeStatus() {
  const bin = await findClaude();
  if (!bin) return { available: false };
  const version = await run(bin, ['--version']);
  return { available: true, version: version.split('\n')[0] || undefined };
}

/** Puts the current propose-edits skill into the folder, where Claude Code will read it. */
async function installSkill(skillSource, folder) {
  const target = path.join(folder, '.claude', 'skills', 'propose-edits');
  await fs.mkdir(target, { recursive: true });
  for (const name of ['SKILL.md', 'shoulder.mjs'])
    await fs.writeFile(path.join(target, name), await fs.readFile(path.join(skillSource, name)));
}

let running;

/**
 * Asks Claude Code for proposals on `docFile` in `folder`, reporting progress through
 * `onEvent`. Resolves when it finishes; the last event is always 'done' or 'error'.
 */
export async function askClaude({ folder, docFile, note, skillSource, onEvent }) {
  if (running) return onEvent({ kind: 'error', text: 'Claude is already working on a document.' });
  const bin = await findClaude();
  if (!bin) return onEvent({ kind: 'error', text: 'Claude Code is not installed on this Mac.' });
  await installSkill(skillSource, folder);
  const args = [
    '-p',
    proposalPrompt(docFile, note),
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    ...ALLOWED_TOOLS,
  ];
  await new Promise((resolve) => {
    let finished = false;
    const finish = (event) => {
      if (finished) return;
      finished = true;
      running = undefined;
      onEvent(event);
      resolve();
    };
    let buffer = '';
    let stderr = '';
    loginPath().then((PATH) => {
      const child = spawn(bin, args, { cwd: folder, env: { ...process.env, PATH } });
      running = child;
      child.stdout.on('data', (chunk) => {
        const { lines, rest } = takeLines(buffer + chunk);
        buffer = rest;
        for (const line of lines)
          for (const event of eventsFromLine(line))
            if (event.kind === 'done' || event.kind === 'error') finish(event);
            else onEvent(event);
      });
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (e) =>
        finish({ kind: 'error', text: `Could not start Claude Code: ${e.message}` }),
      );
      child.on('close', (code, signal) => {
        if (signal) return finish({ kind: 'error', text: 'Stopped.' });
        const hint = /log ?in|auth|credential/i.test(stderr)
          ? ' Open a terminal, run "claude", and sign in.'
          : '';
        finish({
          kind: code === 0 ? 'done' : 'error',
          text:
            code === 0
              ? ''
              : `Claude Code exited with an error.${hint} ${stderr.trim().slice(0, 300)}`.trim(),
        });
      });
    });
  });
}

export function cancelClaude() {
  running?.kill('SIGTERM');
}
