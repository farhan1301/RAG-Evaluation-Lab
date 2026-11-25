import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { summary, revisionSummary, type Summary } from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';

type Table = 'datasets' | 'pipelines';
function tables(kind: Table) {
  return kind === 'datasets'
    ? { history: 'dataset_revisions', fk: 'dataset_id' }
    : { history: 'pipeline_revisions', fk: 'pipeline_id' };
}
export const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

export function paginate<T>(
  rows: T[],
  limit: number,
  cursor: (entry: T) => string,
) {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? cursor(items[limit - 1]) : null,
  };
}

export class Definitions {
  constructor(
    protected readonly db: DatabaseSync,
    private readonly kind: Table,
  ) {}

  list(limit: number, cursor = '') {
    const { history, fk } = tables(this.kind);
    const rows = this.db
      .prepare(`SELECT id, r.name, h.revision FROM ${this.kind} h JOIN ${history} r
      ON h.id=r.${fk} AND r.revision=h.revision WHERE h.archived=0 AND id>? ORDER BY id LIMIT ?`)
      .all(cursor, limit + 1)
      .map((row) => summary.parse({ ...row, archived: false }));
    return paginate(rows, limit, (item) => item.id);
  }

  head(id: string, frozen?: number): Summary {
    const { history, fk } = tables(this.kind);
    const row = this.db
      .prepare(`SELECT id,r.name,r.revision,h.archived FROM ${this.kind} h JOIN ${history} r
      ON r.${fk}=h.id AND r.revision=coalesce(?,h.revision) WHERE h.id=?`)
      .get(frozen ?? null, id);
    if (!row) return missing();
    return summary.parse({
      ...row,
      archived: frozen === undefined && row.archived === 1,
    });
  }

  protected writable(id: string, expected: number) {
    const current = this.head(id);
    if (current.archived)
      throw new ApiError(409, 'archived', 'This resource has been archived.');
    if (current.revision !== expected)
      throw new ApiError(
        409,
        'stale_revision',
        'Another editor saved changes. Load the latest revision before retrying.',
      );
    return current;
  }

  revisions(id: string, limit: number, cursor = 0) {
    this.head(id);
    const { history, fk } = tables(this.kind);
    const rows = this.db
      .prepare(`SELECT name,revision,created_at AS createdAt FROM ${history}
      WHERE ${fk}=? AND revision>? ORDER BY revision LIMIT ?`)
      .all(id, cursor, limit + 1)
      .map((row) => revisionSummary.parse(row));
    return paginate(rows, limit, (item) => String(item.revision));
  }

  archive(id: string, expected: number) {
    const result = this.db
      .prepare(
        `UPDATE ${this.kind} SET archived=1 WHERE id=? AND revision=? AND archived=0`,
      )
      .run(id, expected);
    if (!result.changes) this.writable(id, expected);
  }
}
