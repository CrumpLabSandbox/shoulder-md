#!/usr/bin/env node
// Helper for the suggest-principles skill. Run from the top of the synced folder. No dependencies.
//   node inbox.mjs edits [--all]   the guides, and the author's reasoned edits to learn from
//   node inbox.mjs check           validate Style/Inbox/suggestions.json
//   node inbox.mjs done            record the edits as analysed
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [cmd, flag] = process.argv.slice(2);
if (!['edits', 'check', 'done'].includes(cmd)) {
  console.error('usage: inbox.mjs edits|check|done [--all]');
  process.exit(2);
}
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const root = process.cwd();
const guidesDir = path.join(root, 'Style', 'Guides');
const inboxDir = path.join(root, 'Style', 'Inbox');
const file = (name) => path.join(inboxDir, name);
const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
if (!existsSync(guidesDir))
  fail('Run this from the top of a shoulder-md synced folder (no Style/Guides here).');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** The base guide and each genre guide: how suggestions name them, and what they already say. */
function guides() {
  const out = [];
  for (const name of readdirSync(guidesDir).sort()) {
    if (!name.endsWith('.shoulder.json') || name.includes('.conflict-')) continue;
    const doc = readJson(path.join(guidesDir, name));
    const meta = doc?.state?.meta;
    if (!meta?.guide) continue;
    const stem = name.slice(0, -'.shoulder.json'.length);
    const mdPath = path.join(guidesDir, `${stem}.md`);
    const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
    const principles = [];
    for (const line of md.split('\n')) {
      const m = /^[-*+] (?:\[([A-Za-z][A-Za-z0-9]*-?\d+)[^\]]*\]\s*)?(.+)$/.exec(line);
      if (m) principles.push({ ...(m[1] ? { id: m[1] } : {}), text: m[2].trim() });
    }
    out.push({
      guide: meta.guide.role === 'base' ? 'base' : meta.title || stem,
      file: `Style/Guides/${stem}.md`,
      sections: [...md.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]),
      principles,
    });
  }
  return out;
}

const allEdits = readJson(file('edits.json'), { edits: [] }).edits ?? [];
const seen = new Set(readJson(file('seen.json'), { edits: [] }).edits ?? []);
const dismissed = (readJson(file('decisions.json'), { decisions: [] }).decisions ?? [])
  .filter((d) => d.action === 'dismissed' && d.principle)
  .map((d) => ({ guide: d.guide, principle: d.principle }));

if (cmd === 'edits') {
  const fresh = flag === '--all' ? allEdits : allEdits.filter((e) => !seen.has(e.id));
  console.log(
    JSON.stringify(
      {
        guides: guides(),
        edits: fresh,
        alreadyAnalysed: allEdits.length - fresh.length,
        dismissed,
        note:
          allEdits.length === 0
            ? 'There are no reasoned edits yet. The author needs to make edits with track changes on and give reasons for them.'
            : fresh.length === 0
              ? 'There are no new reasoned edits since the last run.'
              : undefined,
        suggestionsFile: 'Style/Inbox/suggestions.json',
        suggestionsWaiting:
          (readJson(file('suggestions.json'), {}).suggestions?.length ?? 0) +
          (readJson(file('suggestions.json'), {}).links?.length ?? 0),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (cmd === 'done') {
  mkdirSync(inboxDir, { recursive: true });
  const ids = [...new Set([...seen, ...allEdits.map((e) => e.id)])];
  writeFileSync(file('seen.json'), JSON.stringify({ edits: ids }, null, 2) + '\n');
  console.log(`Recorded ${allEdits.length} edits as analysed.`);
  process.exit(0);
}

// check
if (!existsSync(file('suggestions.json')))
  fail('Nothing to check: Style/Inbox/suggestions.json does not exist.');
let inbox;
try {
  inbox = JSON.parse(readFileSync(file('suggestions.json'), 'utf8'));
} catch (e) {
  fail(`suggestions.json is not valid JSON: ${e.message}`);
}
const known = guides();
const editIds = new Set(allEdits.map((e) => e.id));
const byGuide = (name) => known.find((g) => norm(g.guide) === norm(name));
const everyId = new Set(known.flatMap((g) => g.principles.map((p) => p.id).filter(Boolean)));
let problems = 0;
const report = (label, issues) => {
  if (!issues.length) return;
  problems++;
  console.log(`${label}: ${issues.join('; ')}`);
};
(inbox.suggestions ?? []).forEach((s, i) => {
  const issues = [];
  const g = byGuide(s.guide ?? '');
  if (!g) issues.push(`"guide" must be one of: ${known.map((k) => k.guide).join(', ')}`);
  if (typeof s.principle !== 'string' || !s.principle.trim()) issues.push('needs a "principle"');
  else {
    if (/^\s*[-*+]\s|^\s*\[/.test(s.principle))
      issues.push('no list marker or id: the app adds them');
    if (dismissed.some((d) => norm(d.principle) === norm(s.principle)))
      issues.push('the author dismissed this before; do not suggest it again');
    if (s.kind !== 'reword' && g?.principles.some((p) => norm(p.text) === norm(s.principle)))
      issues.push('the guide already has this principle');
  }
  if (s.kind === 'reword') {
    if (!g?.principles.some((p) => p.id === s.id))
      issues.push(`"id" must be a principle in ${s.guide}`);
  } else if (s.kind !== 'new') issues.push('"kind" must be "new" or "reword"');
  const edits = Array.isArray(s.edits) ? s.edits : [];
  if (edits.length < 2 && s.kind !== 'reword') issues.push('needs at least two supporting "edits"');
  for (const id of edits) if (!editIds.has(id)) issues.push(`unknown edit ${id}`);
  if (!s.reason || !String(s.reason).trim()) issues.push('missing "reason"');
  report(`suggestion #${i + 1} ${JSON.stringify(String(s.principle).slice(0, 50))}`, issues);
});
(inbox.links ?? []).forEach((l, i) => {
  const issues = [];
  const edit = allEdits.find((e) => e.id === l.edit);
  if (!edit) issues.push(`unknown edit ${l.edit}`);
  for (const id of l.principles ?? []) {
    if (!everyId.has(id)) issues.push(`unknown principle ${id}`);
    else if (edit?.principles?.includes(id)) issues.push(`the edit is already linked to ${id}`);
  }
  if (!(l.principles ?? []).length) issues.push('needs "principles"');
  report(`link #${i + 1}`, issues);
});
const total = (inbox.suggestions?.length ?? 0) + (inbox.links?.length ?? 0);
console.log(
  problems
    ? `${problems} of ${total} entries need fixing.`
    : `All ${total} entries are well formed.`,
);
process.exit(problems ? 1 : 0);
