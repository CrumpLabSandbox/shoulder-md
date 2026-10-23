// @vitest-environment node
// Git sync against real git: a bare repository in a temporary folder stands in for GitHub, and
// two folders stand in for two Macs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  changedNames,
  classify,
  conflictName,
  pickHistory,
  repoName,
  validRemote,
  withLines,
} from '../electron/git-merge.mjs';

process.env.SHOULDER_GIT_BIN = 'git';
const { setup, status, sync, checkRemote } = await import('../electron/git.mjs');

/** A sync that must succeed, narrowed to its successful result. */
async function synced(dir: string) {
  const r = await sync(dir);
  if (!r.ok) throw new Error(r.error);
  return r;
}

const doc = (id: string, ops: string[]) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    ops: ops.map((o) => ({ id: o, type: 'edit', insert: o })),
  });

describe('settling a file both Macs changed', () => {
  it('keeps the history that extends the other, or both when they diverged', () => {
    expect(pickHistory(doc('d', ['a']), doc('d', ['a', 'b']))).toBe('theirs');
    expect(pickHistory(doc('d', ['a', 'b']), doc('d', ['a']))).toBe('ours');
    expect(pickHistory(doc('d', ['a']), doc('d', ['a']))).toBe('ours');
    expect(pickHistory(doc('d', ['a', 'x']), doc('d', ['a', 'y']))).toBe('both');
    expect(pickHistory(doc('d', ['a']), doc('e', ['a', 'b']))).toBe('both');
    expect(pickHistory('not json', doc('d', ['a']))).toBe('both');
  });

  it('treats a typing run that grew differently as a different op', () => {
    const grown = JSON.stringify({ id: 'd', ops: [{ id: 'a', type: 'edit', insert: 'hel' }] });
    const longer = JSON.stringify({ id: 'd', ops: [{ id: 'a', type: 'edit', insert: 'hello' }] });
    expect(pickHistory(grown, longer)).toBe('both');
  });

  it('names conflict copies the way folder sync does', () => {
    const at = '20261023-101500';
    expect(conflictName('Documents/a/a.shoulder.json', at)).toBe(
      `Documents/a/a.conflict-${at}.shoulder.json`,
    );
    expect(conflictName('Documents/a/a.md', at)).toBe(`Documents/a/a.conflict-${at}.md`);
    expect(conflictName('Documents/a/a.chat.md', at)).toBe(`Documents/a/a.conflict-${at}.chat.md`);
    expect(conflictName('notes', at)).toBe(`notes.conflict-${at}`);
  });

  it('describes a commit by the documents it touches', () => {
    expect(
      changedNames([
        'Documents/grant/grant.md',
        'Documents/grant/grant.shoulder.json',
        'Style/Guides/blog.md',
      ]),
    ).toBe('grant, blog');
    expect(changedNames(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d and 2 more');
  });

  it('adds only the lines a file is missing', () => {
    expect(withLines('.DS_Store\n', ['.DS_Store', '.claude/'], 'Shoulder')).toBe(
      '.DS_Store\n\n# Shoulder\n.claude/\n',
    );
    expect(withLines('.claude/\n', ['.claude/'], 'Shoulder')).toBeUndefined();
  });

  it('accepts repository addresses and refuses anything that could be an option', () => {
    for (const ok of [
      'https://github.com/me/ShoulderDocs.git',
      'git@github.com:me/ShoulderDocs.git',
      'git@github-shoulder:me/ShoulderDocs.git',
      'ssh://me@mini.local/~/ShoulderDocs.git',
      '/Volumes/Mini/ShoulderDocs.git',
    ])
      expect(validRemote(ok), ok).toBe(true);
    for (const bad of ['', '-oProxyCommand=x', 'https://x y', 'ext::sh -c x', 'github.com', ' /x'])
      expect(validRemote(bad), bad).toBe(false);
    expect(repoName('git@github.com:me/ShoulderDocs.git')).toBe('ShoulderDocs');
    expect(repoName('https://github.com/me/ShoulderDocs/')).toBe('ShoulderDocs');
  });

  it('says why a command failed', () => {
    expect(classify('remote: Repository not found.')).toBe('not-found');
    expect(classify('git@github.com: Permission denied (publickey).')).toBe('auth');
    expect(classify('fatal: could not read Username for https://github.com')).toBe('auth');
    expect(classify('ssh: Could not resolve host: github.com')).toBe('network');
  });
});

describe('two Macs and one repository', () => {
  let root: string;
  let remote: string;
  let home: string;
  let work: string;

  const put = (dir: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const has = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
  const tracked = (dir: string) =>
    execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  const all = (dir: string): string[] =>
    fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => !p.startsWith('.git'));
  const noMarkers = (dir: string) => {
    for (const p of all(dir)) {
      const full = path.join(dir, p);
      if (fs.statSync(full).isFile())
        expect(fs.readFileSync(full, 'utf8')).not.toContain('<<<<<<<');
    }
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shoulder-git-'));
    remote = path.join(root, 'remote', 'ShoulderDocs.git');
    fs.mkdirSync(remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    home = path.join(root, 'Shoulder');
    work = path.join(root, 'work', 'ShoulderDocs');
    fs.mkdirSync(work, { recursive: true });
    put(home, 'Documents/grant/grant.md', '# Grant\n');
    put(home, 'Documents/grant/grant.shoulder.json', doc('grant', ['a']));
    put(home, 'Documents/grant/grant.proposals.json', '{"proposals":[]}');
    put(home, 'Style/Samples/README.md', '# Samples\n');
    put(home, 'Style/Samples/Grants/proposal.pdf', 'pdf bytes');
    put(home, '.claude/skills/propose-edits/SKILL.md', 'skill');
    put(work, 'Style/Samples/README.md', '# Samples\n');
    put(work, 'Style/Samples/Blog/post.md', 'a work sample');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports a folder that does not sync yet', async () => {
    expect(await status(home)).toMatchObject({ available: true, repo: false });
    expect(await checkRemote(remote)).toEqual({ ok: true, empty: true });
  });

  it('refuses a repository that is not there, with the reason', async () => {
    const r = await setup(home, path.join(root, 'nowhere.git'));
    expect(r).toMatchObject({ ok: false, reason: 'not-found' });
    expect(has(home, '.git')).toBe(false);
  });

  it('uploads the first Mac’s folder, leaving out what stays on each Mac', async () => {
    const r = await setup(home, remote);
    expect(r).toMatchObject({ ok: true, folder: home, cloned: false });
    const files = tracked(home);
    expect(files).toContain('Documents/grant/grant.shoulder.json');
    expect(files).toContain('.gitignore');
    expect(files.some((f) => f.includes('proposals') || f.startsWith('.claude'))).toBe(false);
    // Samples stay on each Mac; only the folder's README goes up.
    expect(files.filter((f) => f.startsWith('Style/Samples/'))).toEqual([
      'Style/Samples/README.md',
    ]);
    expect(await status(home)).toMatchObject({ repo: true, remote, dirty: false });
  });

  it('downloads it on a second Mac whose folder has nothing of its own', async () => {
    const r = await setup(work, remote);
    expect(r).toMatchObject({ ok: true, cloned: true });
    expect(read(work, 'Documents/grant/grant.shoulder.json')).toBe(doc('grant', ['a']));
    expect(read(work, 'Style/Samples/Blog/post.md')).toBe('a work sample');
    expect(has(work, 'Style/Samples/Grants/proposal.pdf')).toBe(false);
  });

  it('carries an edit from one Mac to the other', async () => {
    put(home, 'Documents/grant/grant.shoulder.json', doc('grant', ['a', 'b']));
    put(home, 'Documents/grant/grant.md', '# Grant\n\nMore.\n');
    expect(await sync(home)).toMatchObject({ ok: true, pushed: true });
    const r = await synced(work);
    expect(r).toMatchObject({ ok: true, conflicts: [] });
    expect(r.changed).toContain('Documents/grant/grant.shoulder.json');
    expect(read(work, 'Documents/grant/grant.md')).toBe('# Grant\n\nMore.\n');
    expect(await sync(work)).toMatchObject({ ok: true, changed: [], pushed: false });
  });

  it('takes the longer history when one Mac’s extends the other’s', async () => {
    put(work, 'Documents/grant/grant.shoulder.json', doc('grant', ['a', 'b', 'c']));
    put(work, 'Documents/grant/grant.md', '# Grant\n\nMore. C.\n');
    put(home, 'Documents/grant/grant.shoulder.json', doc('grant', ['a', 'b', 'c', 'd']));
    put(home, 'Documents/grant/grant.md', '# Grant\n\nMore. C. D.\n');
    expect(await sync(home)).toMatchObject({ ok: true, pushed: true });
    const r = await synced(work);
    expect(r.ok).toBe(true);
    expect(r.conflicts.map((c: { kept: string }) => c.kept)).toEqual(['theirs', 'theirs']);
    expect(read(work, 'Documents/grant/grant.shoulder.json')).toBe(
      doc('grant', ['a', 'b', 'c', 'd']),
    );
    expect(read(work, 'Documents/grant/grant.md')).toBe('# Grant\n\nMore. C. D.\n');
    expect(all(work).some((p) => p.includes('.conflict-'))).toBe(false);
    noMarkers(work);
  });

  it('keeps both when the histories diverged, and never leaves conflict markers', async () => {
    await sync(home);
    put(home, 'Documents/grant/grant.shoulder.json', doc('grant', ['a', 'b', 'c', 'd', 'home']));
    put(home, 'Documents/grant/grant.md', '# Home\n');
    put(work, 'Documents/grant/grant.shoulder.json', doc('grant', ['a', 'b', 'c', 'd', 'work']));
    put(work, 'Documents/grant/grant.md', '# Work\n');
    put(home, 'notes.txt', 'home notes\n');
    put(work, 'notes.txt', 'work notes\n');
    expect(await sync(home)).toMatchObject({ ok: true, pushed: true });
    const r = await synced(work);
    expect(r).toMatchObject({ ok: true, pushed: true });
    expect(read(work, 'Documents/grant/grant.md')).toBe('# Work\n');
    expect(read(work, 'notes.txt')).toBe('work notes\n');
    const copies = all(work).filter((p) => p.includes('.conflict-'));
    expect(copies).toHaveLength(3);
    const homeJson = copies.find((p) => p.endsWith('.shoulder.json'))!;
    expect(read(work, homeJson)).toBe(doc('grant', ['a', 'b', 'c', 'd', 'home']));
    noMarkers(work);
    // The home Mac receives the work Mac's version and the copy of its own.
    expect(await sync(home)).toMatchObject({ ok: true, conflicts: [] });
    expect(read(home, 'Documents/grant/grant.md')).toBe('# Work\n');
    expect(all(home).filter((p) => p.includes('.conflict-'))).toHaveLength(3);
  });

  it('asks before combining two folders that both have documents, then combines them', async () => {
    const other = path.join(root, 'other');
    put(other, 'Documents/notes/notes.md', '# Notes\n');
    put(other, 'Documents/notes/notes.shoulder.json', doc('notes', ['n']));
    expect(await setup(other, remote)).toEqual({ ok: false, needsChoice: true });
    expect(has(other, '.git')).toBe(false);
    const r = await setup(other, remote, { combine: true });
    expect(r).toMatchObject({ ok: true, cloned: true });
    expect(has(other, 'Documents/grant/grant.md')).toBe(true);
    expect(has(other, 'Documents/notes/notes.md')).toBe(true);
    expect(all(other).some((p) => p.includes('.gitignore.conflict'))).toBe(false);
    noMarkers(other);
    expect((await synced(home)).changed).toContain('Documents/notes/notes.md');
  });

  it('renames a new folder after the repository when asked', async () => {
    const fresh = path.join(root, 'fresh', 'Shoulder');
    put(fresh, 'Documents/x/x.md', '# X\n');
    const empty = path.join(root, 'remote', 'Empty.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', empty]);
    const r = await setup(fresh, empty, { rename: true });
    expect(r).toMatchObject({ ok: true, folder: path.join(root, 'fresh', 'Empty') });
    expect(has(path.join(root, 'fresh', 'Empty'), 'Documents/x/x.md')).toBe(true);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('will not point a synced folder at a different repository', async () => {
    const r = await setup(home, path.join(root, 'remote', 'Empty.git'));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('already syncs') });
  });
});
