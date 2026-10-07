/** Per-document numbers and metadata shown in the document list and the library view. */
import type { DocMeta, GuideMeta, State } from '../model/types';
import { parsePrinciples, type Principle } from '../guides/principles';
import { markedRanges, text as viewText } from '../model/views';
import { displayTitle } from '../docs/title';
import { countWords } from '../util/text';

export type DocStats = {
  title: string;
  words: number;
  pendingChanges: number;
  acceptedChanges: number;
  rejectedChanges: number;
  /** Tracked changes that carry a reason (their own or their group's) or reason tags. */
  reasoned: number;
  comments: number;
  status: DocMeta['status'];
  tags: string[];
  libraryEligible: boolean;
  /** The genre guide's document id, if any. */
  genre?: string;
  /** Explicit Claude access, if set; otherwise the genre's default applies. */
  claude?: boolean;
  /** Set on style guides, with their parsed principles. */
  guide?: GuideMeta & { principles: Principle[]; unnumbered: number };
};

export function docStats(state: State): DocStats {
  const clean = viewText(state, 'clean');
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  let reasoned = 0;
  // Pending means still marked in the text: a change whose marks all went away with another
  // decision (say, a deletion of an insertion that was rejected) has nothing left to review.
  const live = new Set(markedRanges(state).map((r) => r.changeId));
  for (const c of Object.values(state.changes)) {
    if (!c.tracked) continue;
    if (c.status === 'pending') pending += live.has(c.id) ? 1 : 0;
    else if (c.status === 'accepted') accepted++;
    else rejected++;
    if (c.reason || c.group || (c.reasonTags?.length ?? 0) > 0) reasoned++;
  }
  return {
    title: displayTitle(state.meta.title, clean),
    words: countWords(clean),
    pendingChanges: pending,
    acceptedChanges: accepted,
    rejectedChanges: rejected,
    reasoned,
    comments: state.comments.filter((t) => !t.resolved).length,
    status: state.meta.status,
    tags: state.meta.tags,
    libraryEligible: state.meta.libraryEligible,
    ...(state.meta.genre ? { genre: state.meta.genre } : {}),
    ...(state.meta.claude !== undefined ? { claude: state.meta.claude } : {}),
    ...(state.meta.guide ? { guide: guideStats(state.meta.guide, clean) } : {}),
  };
}

function guideStats(
  meta: GuideMeta,
  clean: string,
): GuideMeta & { principles: Principle[]; unnumbered: number } {
  const parsed = parsePrinciples(clean);
  return { ...meta, principles: parsed.principles, unnumbered: parsed.unnumbered.length };
}
