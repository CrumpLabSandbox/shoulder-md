#!/usr/bin/env node
// Helper for the propose-edits skill. No dependencies.
//   node shoulder.mjs context <document.md>   what the document is and which guides apply
//   node shoulder.mjs check <document.md>     validate <document>.proposals.json against the .md
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [cmd, target] = process.argv.slice(2);
if (!['context', 'check'].includes(cmd) || !target) {
  console.error('usage: shoulder.mjs context|check <document.md>');
  process.exit(2);
}

const md = path.resolve(target);
const dir = path.dirname(md);
const base = path.basename(md).replace(/\.md$/i, '');
const jsonPath = path.join(dir, `${base}.shoulder.json`);
const proposalsPath = path.join(dir, `${base}.proposals.json`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
if (!existsSync(md)) fail(`No such file: ${md}`);
if (!existsSync(jsonPath))
  fail(
    `${base}.shoulder.json is not next to the .md, so this is not a synced shoulder-md document.`,
  );

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Every synced document in the folder: file stem, id and metadata. */
function siblings() {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.shoulder.json') || name.includes('.conflict-')) continue;
    try {
      const doc = readJson(path.join(dir, name));
      out.push({ stem: name.slice(0, -'.shoulder.json'.length), id: doc.id, meta: doc.state.meta });
    } catch {
      // unreadable: not a document we can use
    }
  }
  return out;
}

/** Principle ids ([B1], [G12 replaces B3]) at the start of top-level list items. */
function principleIds(file) {
  if (!file || !existsSync(file)) return [];
  const ids = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^[-*+] \[([A-Za-z][A-Za-z0-9]*-?\d+)(?:\s+replaces\s+[A-Za-z0-9-]+)?\]/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function guides() {
  const all = siblings();
  const self = all.find((d) => d.stem === base);
  const baseGuide = all.find((d) => d.meta.guide?.role === 'base');
  const genre = self?.meta.genre ? all.find((d) => d.id === self.meta.genre) : undefined;
  const file = (d) => (d ? path.join(dir, `${d.stem}.md`) : undefined);
  return {
    self,
    baseGuide: file(baseGuide),
    genreGuide: file(genre),
    genreMissing: !!self?.meta.genre && !genre,
  };
}

if (cmd === 'context') {
  const g = guides();
  console.log(
    JSON.stringify(
      {
        document: md,
        documentId: g.self?.id,
        isGuide: !!g.self?.meta.guide,
        baseGuide: g.baseGuide ?? null,
        genreGuide: g.genreGuide ?? null,
        note: g.genreMissing
          ? "The document's genre guide is not in this folder (it may be private). Use the base guide only and say so."
          : !g.self?.meta.genre
            ? 'The document has no genre; only the base guide applies.'
            : undefined,
        proposalsFile: proposalsPath,
        proposalsFileExists: existsSync(proposalsPath),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// check
if (!existsSync(proposalsPath)) fail(`Nothing to check: ${proposalsPath} does not exist.`);
const text = readFileSync(md, 'utf8');
let file;
try {
  file = readJson(proposalsPath);
} catch (e) {
  fail(`${base}.proposals.json is not valid JSON: ${e.message}`);
}
if (!Array.isArray(file.proposals)) fail('The file needs a "proposals" list.');

const count = (quote) => {
  let n = 0;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) n++;
  if (n > 0) return n;
  const escaped = quote
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return [...text.matchAll(new RegExp(escaped.join('\\s+'), 'g'))].length;
};
const g = guides();
const known = new Set([...principleIds(g.baseGuide), ...principleIds(g.genreGuide)]);
const spans = [];
let problems = 0;
file.proposals.forEach((p, i) => {
  const issues = [];
  if (typeof p.quote !== 'string' || typeof p.replacement !== 'string') {
    issues.push('needs string "quote" and "replacement"');
  } else {
    const n = p.quote.trim() ? count(p.quote) : 0;
    if (n === 0) issues.push('quote not found in the .md (copy it exactly)');
    if (n > 1) issues.push(`quote occurs ${n} times (add neighbouring words until it is unique)`);
    if (p.quote === p.replacement) issues.push('replacement is the same as the quote');
    const at = text.indexOf(p.quote);
    if (n === 1 && at >= 0) {
      if (spans.some(([a, b]) => at <= b && a <= at + p.quote.length))
        issues.push('quote overlaps or touches an earlier proposal (merge them or drop one)');
      spans.push([at, at + p.quote.length]);
    }
  }
  if (!p.reason || !String(p.reason).trim()) issues.push('missing "reason"');
  for (const id of p.principles ?? [])
    if (!known.has(id)) issues.push(`principle ${id} is not in the guides for this document`);
  if (issues.length) {
    problems++;
    console.log(`#${i + 1} ${JSON.stringify(String(p.quote).slice(0, 50))}: ${issues.join('; ')}`);
  }
});
console.log(
  problems
    ? `${problems} of ${file.proposals.length} proposals need fixing.`
    : `All ${file.proposals.length} proposals are placeable.`,
);
process.exit(problems ? 1 : 0);
