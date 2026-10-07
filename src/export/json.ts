/** Full-document JSON export and import. The op log is the truth; the state is checked on import. */
import type { Document } from '../model/types';
import { SCHEMA_VERSION } from '../model/types';
import { replay } from '../model/apply';
import { hashState } from '../model/hash';

/** Compact, with one op per line so the file stays small and still diffs line by line in git. */
export function exportJson(doc: Document): string {
  const { ops, state, ...head } = doc;
  const start = JSON.stringify(head).slice(0, -1);
  const lines = ops.map((op) => JSON.stringify(op)).join(',\n');
  return `${start},\n"ops":[\n${lines}\n],\n"state":${JSON.stringify(state)}}\n`;
}

export class ImportError extends Error {}

/**
 * Parses and checks an exported document. Structural checks are light; the real check is that
 * replaying the op log reproduces the stored state. If it does not, the replayed state wins.
 */
export function importJson(text: string): { doc: Document; repaired: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError('Not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new ImportError('Not a document');
  const d = raw as Partial<Document>;
  if (d.schemaVersion !== SCHEMA_VERSION)
    throw new ImportError(`Unsupported schema version ${String(d.schemaVersion)}`);
  if (typeof d.id !== 'string' || !d.id) throw new ImportError('Missing document id');
  if (!Array.isArray(d.ops) || d.ops.length === 0) throw new ImportError('Missing op log');
  if (d.ops[0]?.type !== 'import') throw new ImportError('The op log must start with an import');
  for (const op of d.ops) {
    if (!op || typeof op !== 'object' || typeof op.type !== 'string' || typeof op.id !== 'string') {
      throw new ImportError('Malformed op in log');
    }
  }
  let replayed;
  try {
    replayed = replay(d.ops, {
      idGen: () => {
        throw new ImportError('An op in the log is missing its allocated ids');
      },
    });
  } catch (e) {
    throw e instanceof ImportError
      ? e
      : new ImportError(`The op log does not replay: ${String(e)}`);
  }
  const stored = d.state;
  const repaired = !stored || hashState(stored) !== hashState(replayed);
  const doc: Document = {
    schemaVersion: SCHEMA_VERSION,
    id: d.id,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : d.ops[0]!.ts,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : d.ops[d.ops.length - 1]!.ts,
    authors: Array.isArray(d.authors) ? d.authors : [],
    ops: d.ops,
    state: replayed,
  };
  return { doc, repaired };
}
