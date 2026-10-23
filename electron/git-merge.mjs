// How git sync settles a file both Macs changed (git-sync.md §5). Pure functions, no git, so
// they can be tested on their own.

/** Same op, not just the same id: a typing run keeps its id while its text grows. */
const sameOp = (a, b) =>
  !!a && !!b && a.id === b.id && (a.type !== 'edit' || b.type !== 'edit' || a.insert === b.insert);

const opsOf = (text) => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.id === 'string' && Array.isArray(parsed.ops)
      ? { id: parsed.id, ops: parsed.ops }
      : undefined;
  } catch {
    return undefined;
  }
};

const isPrefix = (short, long) =>
  short.length <= long.length && short.every((op, i) => sameOp(op, long[i]));

/**
 * Which version of a document's `.shoulder.json` to keep when both Macs changed it: the one
 * whose history extends the other's ('ours' or 'theirs'), or 'both' when they diverged (keep
 * ours, save theirs as a conflict copy). Anything unreadable counts as diverged.
 */
export function pickHistory(oursText, theirsText) {
  const ours = opsOf(oursText);
  const theirs = opsOf(theirsText);
  if (!ours || !theirs || ours.id !== theirs.id) return 'both';
  if (isPrefix(ours.ops, theirs.ops))
    return ours.ops.length === theirs.ops.length ? 'ours' : 'theirs';
  if (isPrefix(theirs.ops, ours.ops)) return 'ours';
  return 'both';
}

export const JSON_EXT = '.shoulder.json';
const MULTI = [JSON_EXT, '.chat.md'];

/** `Documents/a/a.shoulder.json` → `Documents/a/a.conflict-<stamp>.shoulder.json`. */
export function conflictName(file, stamp) {
  const slash = file.lastIndexOf('/');
  const dir = file.slice(0, slash + 1);
  const name = file.slice(slash + 1);
  const ext = MULTI.find((e) => name.endsWith(e) && name.length > e.length);
  const dot = name.lastIndexOf('.');
  const [stem, tail] = ext
    ? [name.slice(0, -ext.length), ext]
    : dot > 0
      ? [name.slice(0, dot), name.slice(dot)]
      : [name, ''];
  return `${dir}${stem}.conflict-${stamp}${tail}`;
}

/** The `.md` that goes with a document's `.shoulder.json`, and the reverse. */
export const mdFor = (jsonFile) => jsonFile.slice(0, -JSON_EXT.length) + '.md';
export const jsonFor = (mdFile) => mdFile.slice(0, -'.md'.length) + JSON_EXT;

/** Local time as YYYYMMDD-HHMMSS, the same stamp folder sync uses for its conflict copies. */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Short names for a commit message: the document folders and guides a set of paths touch. */
export function changedNames(paths) {
  const names = [];
  for (const p of paths) {
    const parts = p.split('/');
    let name;
    if (parts[0] === 'Documents' && parts.length >= 3) name = parts[1];
    else if (parts[0] === 'Style' && parts[1] === 'Guides' && parts[2])
      name = parts[2].replace(/(\.conflict-[\d-]+)?(\.shoulder\.json|\.chat\.md|\.md)$/, '');
    else if (parts[0] === 'Style' && parts[1]) name = `${parts[1]} (${parts.at(-1)})`;
    else name = parts.at(-1);
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`;
}

/** The lines git sync needs in the folder's `.gitignore` (git-sync.md §3). */
export const IGNORE_LINES = [
  '.DS_Store',
  '.claude/',
  '*.proposals.json',
  '*.proposals.skipped.json',
  '*.revision.md',
  '*.principles.json',
  'Style/Inbox/suggestions.json',
  'Style/Inbox/edits.json',
  'Style/Samples/*',
  '!Style/Samples/README.md',
  '.*.tmp',
];

/** Every file is merged whole: git never mixes lines from two Macs into one file. */
export const ATTRIBUTE_LINES = ['* merge=binary'];

/** `existing` with any of `wanted` it lacks added at the end, or undefined if none are missing. */
export function withLines(existing, wanted, heading) {
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = wanted.filter((l) => !have.has(l));
  if (!missing.length) return undefined;
  const base = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  return `${base}${base ? '\n' : ''}# ${heading}\n${missing.join('\n')}\n`;
}

/** Accepts the remote addresses git sync supports; anything else (or an option) is refused. */
export function validRemote(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u !== url || /\s/.test(u) || u.startsWith('-')) return false;
  return (
    /^https:\/\/[^/]+\/.+/.test(u) ||
    /^ssh:\/\/[^/]+\/.+/.test(u) ||
    /^[\w.-]+@[\w.-]+:[^/].*/.test(u) ||
    /^file:\/\/\/.+/.test(u) ||
    /^\/.+/.test(u)
  );
}

/** The repository's own name from its address: `git@github.com:me/ShoulderDocs.git` → `ShoulderDocs`. */
export function repoName(url) {
  const last = url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? '';
  return last.replace(/\.git$/, '');
}

/** A plain reason for a failed git command, from what it printed. */
export function classify(stderr) {
  const s = String(stderr);
  if (
    /repository .* not found|Repository not found|does not appear to be a git repository|not found/i.test(
      s,
    )
  )
    return 'not-found';
  if (
    /could not read (Username|Password)|Authentication failed|Permission denied|terminal prompts disabled|returned error: 40[13]|Host key verification failed|publickey/i.test(
      s,
    )
  )
    return 'auth';
  if (
    /Could not resolve host|unable to access|Network is unreachable|timed out|Connection refused|Operation timed out|Connection reset/i.test(
      s,
    )
  )
    return 'network';
  return 'other';
}

export const REASON_TEXT = {
  'no-git':
    'Git is not installed on this Mac. Install Apple’s command line tools (run "xcode-select --install" in Terminal) and try again.',
  'not-found':
    'The repository was not found, or this Mac is not signed in to reach it. Check the address and the sign-in steps in the setup guide.',
  auth: 'This Mac could not sign in to the repository. Follow the sign-in step in the setup guide, then try again.',
  network:
    'The repository could not be reached. Check the network connection; Shoulder will try again later.',
  busy: 'Claude is working in the folder; sync runs once it finishes.',
};
