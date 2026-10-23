// Git sync for the shared folder (git-sync.md). The app runs this Mac's own git with a fixed set
// of commands; git signs in however this Mac is already set up to (an SSH key, or GitHub CLI's
// credential helper). Shoulder never sees or stores a password, token or key, and git is never
// allowed to stop and ask for one: a sign-in problem fails with a message instead.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeBusy, loginPath } from './claude.mjs';
import {
  ATTRIBUTE_LINES,
  IGNORE_LINES,
  JSON_EXT,
  REASON_TEXT,
  changedNames,
  classify,
  conflictName,
  jsonFor,
  mdFor,
  pickHistory,
  repoName,
  stamp,
  validRemote,
  withLines,
} from './git-merge.mjs';

const LOCAL_MS = 20_000;
const NETWORK_MS = 90_000;

class GitError extends Error {
  constructor(reason, detail = '') {
    super(REASON_TEXT[reason] ?? (detail.trim().split('\n').slice(-3).join(' ') || 'Git failed.'));
    this.reason = reason;
    this.detail = detail;
  }
}

/* ---------- finding and running git ---------- */

let found;

/** Where git is, or undefined. `/usr/bin/git` only counts when Apple's tools are installed. */
export async function findGit() {
  if (process.env.SHOULDER_GIT_BIN) return process.env.SHOULDER_GIT_BIN;
  if (found) return found;
  const candidates = ['/opt/homebrew/bin/git', '/usr/local/bin/git'];
  for (const dir of (await loginPath()).split(':'))
    if (dir && dir !== '/usr/bin') candidates.push(path.join(dir, 'git'));
  for (const c of candidates) {
    try {
      await fs.access(c, fs.constants.X_OK);
      return (found = c);
    } catch {
      // keep looking
    }
  }
  // Without the command line tools, /usr/bin/git is a stub that offers to install them.
  const tools = await new Promise((resolve) =>
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }, (e) => resolve(!e)),
  );
  return tools ? (found = '/usr/bin/git') : undefined;
}

async function gitEnv() {
  return {
    ...process.env,
    PATH: process.env.SHOULDER_GIT_BIN ? process.env.PATH : await loginPath(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
  };
}

/**
 * Runs git in `cwd`. Resolves with { code, stdout, stderr }; rejects only when git cannot be
 * started. `buffer` returns stdout as bytes (for file contents).
 */
async function git(cwd, args, { timeout = LOCAL_MS, buffer = false, ok = [0] } = {}) {
  const bin = await findGit();
  if (!bin) throw new GitError('no-git');
  const env = await gitEnv();
  const r = await new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        env,
        timeout,
        maxBuffer: 256 * 1024 * 1024,
        encoding: buffer ? 'buffer' : 'utf8',
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          killed: !!error?.killed,
          stdout,
          stderr: String(stderr ?? ''),
        }),
    );
  });
  if (r.killed) throw new GitError('network', `git ${args[0]} timed out`);
  if (!ok.includes(r.code)) throw new GitError(classify(r.stderr), r.stderr);
  return r;
}

const out = async (cwd, args, opts) => String((await git(cwd, args, opts)).stdout).trim();
const succeeds = async (cwd, args) => (await git(cwd, args, { ok: [0, 1, 128] })).code === 0;

const exists = (p) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

let computerName;
/** The Mac's name as its owner set it ("Matt’s iMac"), for commit messages. */
async function macName() {
  if (computerName === undefined) {
    computerName = await new Promise((resolve) =>
      execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 3000 }, (e, so) =>
        resolve(e ? '' : String(so).trim()),
      ),
    );
    if (!computerName) computerName = os.hostname().replace(/\.local$/, '');
  }
  return computerName;
}

/* ---------- one lock per folder ---------- */

const locks = new Map();
function locked(dir, fn) {
  const prev = locks.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    dir,
    next.catch(() => {}),
  );
  return next;
}

/* ---------- status ---------- */

/** Whether `dir` is itself the top of a git repository (not just inside one). */
async function isRepoRoot(dir) {
  if (!(await exists(path.join(dir, '.git')))) return false;
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { ok: [0, 128] });
  if (r.code !== 0) return false;
  const [a, b] = await Promise.all([fs.realpath(String(r.stdout).trim()), fs.realpath(dir)]);
  return a === b;
}

const remoteOf = async (dir) => {
  const r = await git(dir, ['remote', 'get-url', 'origin'], { ok: [0, 2, 128] });
  return r.code === 0 ? String(r.stdout).trim() : undefined;
};

/** What the page shows: is git here, is the folder a repository, and where it syncs to. */
export async function status(dir) {
  const bin = await findGit();
  if (!bin) return { available: false, repo: false };
  if (!(await isRepoRoot(dir))) return { available: true, repo: false };
  const remote = await remoteOf(dir);
  const branch = await out(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { ok: [0, 128] });
  const dirty = (await out(dir, ['status', '--porcelain'])).length > 0;
  return { available: true, repo: true, remote, branch: branch || 'main', dirty };
}

/** Checks an address before setup: reachable, and whether it is still empty. */
export async function checkRemote(url) {
  if (!validRemote(url))
    return { ok: false, reason: 'other', error: 'That is not a repository address git can use.' };
  try {
    const r = await git(os.tmpdir(), ['ls-remote', '--heads', url], { timeout: NETWORK_MS });
    return { ok: true, empty: String(r.stdout).trim() === '' };
  } catch (e) {
    return failure(e);
  }
}

function failure(e) {
  if (e instanceof GitError) return { ok: false, reason: e.reason, error: e.message };
  return { ok: false, reason: 'other', error: e instanceof Error ? e.message : String(e) };
}

/* ---------- the folder's own git files ---------- */

async function ensureGitFiles(dir) {
  for (const [name, lines, heading] of [
    ['.gitignore', IGNORE_LINES, 'Shoulder: files that stay on each Mac'],
    ['.gitattributes', ATTRIBUTE_LINES, 'Shoulder: merge files whole, never line by line'],
  ]) {
    const file = path.join(dir, name);
    const existing = await fs.readFile(file, 'utf8').catch(() => '');
    const next = withLines(existing, lines, heading);
    if (next !== undefined) await fs.writeFile(file, next);
  }
}

/** Commits are signed with the Mac's git identity; a Mac without one gets a plain local one. */
async function ensureIdentity(dir) {
  const email = await git(dir, ['config', 'user.email'], { ok: [0, 1] });
  if (String(email.stdout).trim()) return;
  const name = await macName();
  await git(dir, ['config', 'user.name', `Shoulder on ${name}`]);
  await git(dir, ['config', 'user.email', 'shoulder@localhost']);
}

/** Whether a folder holds anything of the user's (documents, guides, samples), not just scaffolding. */
async function hasContent(dir, rel = '') {
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (['.git', '.claude', '.DS_Store', '.gitignore', '.gitattributes'].includes(e.name)) continue;
    // Samples stay on each Mac (they are git-ignored), so they do not make a folder "full".
    if (p === 'Style/Samples') continue;
    if (e.isDirectory()) {
      if (await hasContent(dir, p)) return true;
    } else if (e.isFile()) return true;
  }
  return false;
}

/** Commits whatever changed in the folder; returns the paths it committed. */
async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  const staged = (await out(dir, ['diff', '--cached', '--name-only', '-z']))
    .split('\0')
    .filter(Boolean);
  if (!staged.length) return [];
  const mac = await macName();
  await git(dir, ['commit', '-q', '-m', message ?? `Shoulder (${mac}): ${changedNames(staged)}`]);
  return staged;
}

/* ---------- conflicts ---------- */

const show = async (dir, spec) => {
  const r = await git(dir, ['show', spec], { buffer: true, ok: [0, 128] });
  return r.code === 0 ? r.stdout : undefined;
};

const write = async (dir, rel, bytes) => {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
};

/**
 * Settles every file git could not merge, so that no file ever holds conflict markers and
 * nothing is lost (git-sync.md §5). Returns what was done to each.
 */
async function settleConflicts(dir, theirsRef) {
  const unmerged = (await out(dir, ['diff', '--name-only', '-z', '--diff-filter=U']))
    .split('\0')
    .filter(Boolean);
  const when = stamp();
  const settled = [];
  const decided = new Map();
  // Documents first: a document's .md follows whichever history its .shoulder.json kept.
  const order = [...unmerged].sort(
    (a, b) => Number(b.endsWith(JSON_EXT)) - Number(a.endsWith(JSON_EXT)),
  );
  for (const file of order) {
    const ours = await show(dir, `:2:${file}`);
    const theirs = await show(dir, `:3:${file}`);
    if (ours && theirs && (file === '.gitignore' || file === '.gitattributes')) {
      // Both Macs' lines are wanted: keep ours and add any of theirs it lacks.
      const lines = theirs
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'));
      const text = ours.toString('utf8');
      await write(dir, file, withLines(text, lines, 'From another Mac') ?? text);
      settled.push({ file, kept: 'both-merged' });
      continue;
    }
    let keep;
    if (!ours || !theirs) keep = ours ? 'ours' : 'theirs';
    else if (file.endsWith(JSON_EXT) && !file.includes('.conflict-'))
      keep = pickHistory(ours.toString('utf8'), theirs.toString('utf8'));
    else if (file.endsWith('.md') && decided.has(jsonFor(file))) keep = decided.get(jsonFor(file));
    else keep = 'both';
    decided.set(file, keep);
    const kept = keep === 'theirs' ? theirs : ours;
    await write(dir, file, kept);
    const entry = { file, kept: keep === 'theirs' ? 'theirs' : 'ours' };
    if (keep === 'both') {
      const copy = conflictName(file, when);
      await write(dir, copy, theirs);
      entry.copy = copy;
      // A document's other half, if git merged it cleanly, still needs its copy beside it.
      if (file.endsWith(JSON_EXT) && !unmerged.includes(mdFor(file))) {
        const md = await show(dir, `${theirsRef}:${mdFor(file)}`);
        if (md) await write(dir, conflictName(mdFor(file), when), md);
      }
    }
    settled.push(entry);
  }
  return settled;
}

/* ---------- syncing ---------- */

async function branchOf(dir) {
  return (await out(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { ok: [0, 128] })) || 'main';
}

const head = (dir) => out(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1, 128] });

/** Brings in what another Mac pushed. Returns the files that changed here, and any conflicts. */
async function mergeRemote(dir, ref, { unrelated = false } = {}) {
  const before = await head(dir);
  if (before && (await succeeds(dir, ['merge-base', '--is-ancestor', ref, 'HEAD'])))
    return { changed: [], conflicts: [] };
  const mac = await macName();
  if (before && (await succeeds(dir, ['merge-base', '--is-ancestor', 'HEAD', ref]))) {
    await git(dir, ['merge', '-q', '--ff-only', ref]);
  } else {
    const args = ['merge', '-q', '--no-ff', '--no-commit', ref];
    if (unrelated) args.splice(1, 0, '--allow-unrelated-histories');
    await git(dir, args, { ok: [0, 1] });
    const conflicts = await settleConflicts(dir, ref);
    await git(dir, ['add', '-A']);
    if (await exists(path.join(dir, '.git', 'MERGE_HEAD')))
      await git(dir, ['commit', '-q', '-m', `Shoulder (${mac}): merge changes from another Mac`]);
    const changed = await changedSince(dir, before);
    return { changed, conflicts };
  }
  return { changed: await changedSince(dir, before), conflicts: [] };
}

async function changedSince(dir, before) {
  if (!before) return (await out(dir, ['ls-files', '-z'])).split('\0').filter(Boolean);
  return (await out(dir, ['diff', '--name-only', '-z', before, 'HEAD']))
    .split('\0')
    .filter(Boolean);
}

async function syncOnce(dir) {
  const branch = await branchOf(dir);
  await git(dir, ['fetch', '-q', 'origin'], { timeout: NETWORK_MS });
  const ref = `origin/${branch}`;
  const remoteHas = await succeeds(dir, ['rev-parse', '--verify', '-q', ref]);
  const merged = remoteHas ? await mergeRemote(dir, ref) : { changed: [], conflicts: [] };
  const ahead = !remoteHas || !(await succeeds(dir, ['merge-base', '--is-ancestor', 'HEAD', ref]));
  if (!ahead) return { ...merged, pushed: false };
  const r = await git(dir, ['push', '-q', '-u', 'origin', branch], {
    timeout: NETWORK_MS,
    ok: [0, 1],
  });
  if (r.code !== 0) {
    if (/rejected|fetch first|non-fast-forward/i.test(r.stderr)) return { ...merged, retry: true };
    throw new GitError(classify(r.stderr), r.stderr);
  }
  return { ...merged, pushed: true };
}

/**
 * Commits this Mac's changes, brings in the other Macs', and pushes (git-sync.md §4). Never
 * leaves the folder mid-merge: on any failure a merge in progress is abandoned.
 */
export function sync(dir) {
  return locked(dir, async () => {
    if (claudeBusy()) return { ok: false, reason: 'busy', error: REASON_TEXT.busy };
    try {
      if (!(await isRepoRoot(dir)))
        return { ok: false, reason: 'not-repo', error: 'This folder is not set up to sync.' };
      // A merge left half done (the app quit during one) is abandoned and redone.
      if (await exists(path.join(dir, '.git', 'MERGE_HEAD'))) await git(dir, ['merge', '--abort']);
      await ensureGitFiles(dir);
      await commitAll(dir);
      const changed = [];
      const conflicts = [];
      let pushed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await syncOnce(dir);
        changed.push(...r.changed.filter((f) => !changed.includes(f)));
        conflicts.push(...r.conflicts);
        pushed = pushed || !!r.pushed;
        if (!r.retry) break;
      }
      return { ok: true, changed, conflicts, pushed };
    } catch (e) {
      if (await exists(path.join(dir, '.git', 'MERGE_HEAD')))
        await git(dir, ['merge', '--abort'], { ok: [0, 128] }).catch(() => {});
      return failure(e);
    }
  });
}

/* ---------- setup ---------- */

/** The default branch of a remote that has one. */
async function remoteBranch(dir) {
  const r = await out(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: NETWORK_MS });
  return /ref: refs\/heads\/(\S+)\s+HEAD/.exec(r)?.[1] ?? 'main';
}

/**
 * Connects a folder to a repository (git-sync.md §6). `rename` renames the folder after the
 * repository first; `combine` adds the repository's documents to a folder that has its own.
 * Resolves with the folder's (possibly new) path, or `needsChoice` when both sides have
 * documents and `combine` was not given.
 */
export function setup(dir, url, { rename = false, combine = false } = {}) {
  return locked(dir, async () => {
    if (claudeBusy()) return { ok: false, reason: 'busy', error: REASON_TEXT.busy };
    const checked = await checkRemote(url);
    if (!checked.ok) return checked;
    try {
      let folder = dir;
      let renameSkipped;
      if (await isRepoRoot(folder)) {
        const current = await remoteOf(folder);
        if (current && current !== url)
          return {
            ok: false,
            reason: 'other',
            error: `This folder already syncs with ${current}. Stop syncing there first, or choose another folder.`,
          };
      }
      const local = await hasContent(folder);
      if (!checked.empty && local && !combine) return { ok: false, needsChoice: true };

      if (rename) {
        const target = path.join(path.dirname(folder), repoName(url));
        if (target === folder) {
          // already named after the repository
        } else if (!repoName(url) || (await exists(target))) renameSkipped = path.basename(target);
        else {
          await fs.rename(folder, target);
          folder = target;
        }
      }

      if (!(await exists(path.join(folder, '.git'))))
        await git(folder, ['init', '-q', '-b', 'main']);
      await ensureIdentity(folder);
      if (!(await remoteOf(folder))) await git(folder, ['remote', 'add', 'origin', url]);
      const mac = await macName();

      if (checked.empty) {
        await ensureGitFiles(folder);
        await commitAll(folder, `Shoulder (${mac}): first sync`);
        if (!(await head(folder)))
          await git(folder, [
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            `Shoulder (${mac}): first sync`,
          ]);
        await git(folder, ['push', '-q', '-u', 'origin', await branchOf(folder)], {
          timeout: NETWORK_MS,
        });
        return { ok: true, folder, cloned: false, renameSkipped };
      }

      await git(folder, ['fetch', '-q', 'origin'], { timeout: NETWORK_MS });
      const branch = await remoteBranch(folder);
      const ref = `origin/${branch}`;
      if (!local) {
        // Only scaffolding here: the repository's copy replaces it.
        await git(folder, ['checkout', '-q', '-f', '-B', branch, ref]);
        await git(folder, ['branch', '-q', '--set-upstream-to', ref]);
        await ensureGitFiles(folder);
        await commitAll(folder);
        return { ok: true, folder, cloned: true, renameSkipped };
      }
      // Both have documents and the user chose to combine them.
      if ((await branchOf(folder)) !== branch && !(await head(folder)))
        await git(folder, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      await ensureGitFiles(folder);
      await commitAll(folder, `Shoulder (${mac}): documents on this Mac before sync`);
      const merged = await mergeRemote(folder, ref, { unrelated: true });
      await git(folder, ['push', '-q', '-u', 'origin', branch], { timeout: NETWORK_MS });
      return { ok: true, folder, cloned: true, conflicts: merged.conflicts, renameSkipped };
    } catch (e) {
      return failure(e);
    }
  });
}
