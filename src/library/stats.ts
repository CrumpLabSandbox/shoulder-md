/** Per-document numbers and metadata shown in the document list and the library view. */
import type { DocMeta, State } from '../model/types';
import { text as viewText } from '../model/views';
import { displayTitle } from '../docs/title';
import { countWords } from '../util/text';

export type DocStats = {
  title: string;
  words: number;
  pendingChanges: number;
  acceptedChanges: number;
  rejectedChanges: number;
  /** Tracked changes that carry a reason or reason tags. */
  reasoned: number;
  comments: number;
  status: DocMeta['status'];
  tags: string[];
  libraryEligible: boolean;
};

export function docStats(state: State): DocStats {
  const clean = viewText(state, 'clean');
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  let reasoned = 0;
  for (const c of Object.values(state.changes)) {
    if (!c.tracked) continue;
    if (c.status === 'pending') pending++;
    else if (c.status === 'accepted') accepted++;
    else rejected++;
    if (c.reason || (c.reasonTags?.length ?? 0) > 0) reasoned++;
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
  };
}
