#!/usr/bin/env node
// Helper for the draft-principles skill. No dependencies.
//   node guide.mjs samples <guide.md> [--all]   the guide's principles and the sample files to read
//   node guide.mjs check <guide.md>             validate <guide>.principles.json
//   node guide.mjs done <guide.md>              record the sample files as read
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [cmd, target, flag] = process.argv.slice(2);
if (!['samples', 'check', 'done'].includes(cmd) || !target) {
  console.error('usage: guide.mjs samples|check|done <guide.md> [--all]');
  process.exit(2);
}
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const md = path.resolve(target);
const dir = path.dirname(md);
const stem = path.basename(md).replace(/\.md$/i, '');
const jsonPath = path.join(dir, `${stem}.shoulder.json`);
if (!existsSync(md) || !existsSync(jsonPath))
  fail(`${target} is not a synced shoulder-md guide (no .md with a .shoulder.json beside it).`);
const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
const meta = doc.state.meta;
if (!meta.guide) fail(`${path.basename(md)} is an ordinary document, not a style guide.`);

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
const title = meta.title || (/^#\s+(.+)$/m.exec(readFileSync(md, 'utf8'))?.[1] ?? stem);
const samplesRoot = path.join(dir, '..', 'Samples');
const manifestPath = path.join(dir, `${stem}.samples.json`);
const suggestionsPath = path.join(dir, `${stem}.principles.json`);

/** The samples folder for this guide's genre: named like the guide, ignoring case and spacing. */
function samplesDir() {
  if (!existsSync(samplesRoot)) return undefined;
  const wanted = new Set([slug(title), slug(stem), slug(stem).replace(/-\d+$/, '')]);
  const match = readdirSync(samplesRoot).find(
    (n) => wanted.has(slug(n)) && statSync(path.join(samplesRoot, n)).isDirectory(),
  );
  return match && path.join(samplesRoot, match);
}

const READABLE = /\.(md|markdown|qmd|rmd|txt|tex|pdf|docx|doc|rtf|html?)$/i;
function walk(folder, out = []) {
  for (const name of readdirSync(folder).sort()) {
    if (name.startsWith('.')) continue;
    const p = path.join(folder, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (READABLE.test(name)) out.push({ path: p, size: s.size, mtime: Math.round(s.mtimeMs) });
  }
  return out;
}

function principles() {
  const out = [];
  for (const line of readFileSync(md, 'utf8').split('\n')) {
    const m = /^[-*+] (?:\[([A-Za-z][A-Za-z0-9]*-?\d+)[^\]]*\]\s*)?(.+)$/.exec(line);
    if (m) out.push({ ...(m[1] ? { id: m[1] } : {}), text: m[2].trim() });
  }
  return out;
}
const sections = () =>
  [...readFileSync(md, 'utf8').matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]);
const rel = (p) => path.relative(path.join(dir, '..', '..'), p);

const folder = samplesDir();
const files = folder ? walk(folder) : [];
const seen = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')).files ?? [])
  : [];
const isNew = (f) =>
  !seen.some((s) => s.path === rel(f.path) && s.size === f.size && s.mtime === f.mtime);

if (cmd === 'samples') {
  const all = flag === '--all';
  console.log(
    JSON.stringify(
      {
        guide: rel(md),
        documentId: doc.id,
        genre: title,
        role: meta.guide.role,
        sections: sections(),
        principles: principles(),
        samplesFolder: folder ? rel(folder) : null,
        note: !folder
          ? `There is no folder for this genre in Style/Samples. Tell the author to create Style/Samples/${title}/ and put examples of their writing in it.`
          : files.length === 0
            ? 'The samples folder has no readable files.'
            : undefined,
        toRead: files
          .filter((f) => all || isNew(f))
          .map((f) => ({ file: rel(f.path), bytes: f.size })),
        alreadyRead: all ? 0 : files.filter((f) => !isNew(f)).length,
        suggestionsFile: rel(suggestionsPath),
        suggestionsFileExists: existsSync(suggestionsPath),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (cmd === 'done') {
  const record = { files: files.map((f) => ({ path: rel(f.path), size: f.size, mtime: f.mtime })) };
  writeFileSync(manifestPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`Recorded ${files.length} sample files as read.`);
  process.exit(0);
}

// check
if (!existsSync(suggestionsPath)) fail(`Nothing to check: ${rel(suggestionsPath)} does not exist.`);
let file;
try {
  file = JSON.parse(readFileSync(suggestionsPath, 'utf8'));
} catch (e) {
  fail(`${path.basename(suggestionsPath)} is not valid JSON: ${e.message}`);
}
if (!Array.isArray(file.principles)) fail('The file needs a "principles" list.');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const have = new Set(principles().map((p) => norm(p.text)));
let problems = 0;
file.principles.forEach((p, i) => {
  const issues = [];
  if (typeof p.principle !== 'string' || !p.principle.trim()) issues.push('needs a "principle"');
  else {
    if (have.has(norm(p.principle))) issues.push('the guide already has this principle');
    if (/^\s*[-*+]\s|^\s*\[/.test(p.principle))
      issues.push('no list marker or id: the app adds them');
    have.add(norm(p.principle));
  }
  if (typeof p.section !== 'string')
    issues.push('needs a "section" (a heading in the guide, or a new one)');
  if (!Array.isArray(p.examples) || p.examples.length === 0)
    issues.push('needs "examples": at least one short quotation with its file');
  if (!p.reason || !String(p.reason).trim()) issues.push('missing "reason"');
  if (issues.length) {
    problems++;
    console.log(
      `#${i + 1} ${JSON.stringify(String(p.principle).slice(0, 50))}: ${issues.join('; ')}`,
    );
  }
});
console.log(
  problems
    ? `${problems} of ${file.principles.length} suggestions need fixing.`
    : `All ${file.principles.length} suggestions are well formed.`,
);
process.exit(problems ? 1 : 0);
