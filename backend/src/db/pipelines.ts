import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  pipeline,
  pipelineInput,
  type PipelineInputRaw,
  type PipelinePatchRaw,
  type SavedPipeline,
} from '@rag-eval/contracts';
import { transaction } from './database.js';
import { Definitions, hash } from './definitions.js';

export class Pipelines extends Definitions {
  constructor(db: DatabaseSync) {
    super(db, 'pipelines');
  }

  get(id: string, frozen?: number): SavedPipeline {
    const head = this.head(id, frozen);
    const row = this.db
      .prepare(
        'SELECT description,config,hash FROM pipeline_revisions WHERE pipeline_id=? AND revision=?',
      )
      .get(id, head.revision);
    return pipeline.parse({
      ...head,
      ...row,
      config: JSON.parse(String(row?.config)),
    });
  }

  private insert(id: string, revision: number, input: PipelineInputRaw) {
    const { name, description, config } = pipelineInput.parse(input);
    const json = JSON.stringify(config);
    this.db
      .prepare('INSERT INTO pipeline_revisions VALUES (?,?,?,?,?,?,?)')
      .run(
        id,
        revision,
        name,
        description,
        json,
        hash(json),
        new Date().toISOString(),
      );
    this.db
      .prepare('UPDATE pipelines SET revision=? WHERE id=?')
      .run(revision, id);
    return this.get(id);
  }

  private fresh(input: PipelineInputRaw) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO pipelines(id,revision) VALUES (?,1)').run(id);
    return this.insert(id, 1, input);
  }
  create(input: PipelineInputRaw) {
    return transaction(this.db, () => this.fresh(input));
  }
  edit(id: string, expected: number, patch: PipelinePatchRaw) {
    return transaction(this.db, () => {
      this.writable(id, expected);
      const { name, description, config } = this.get(id);
      return this.insert(id, expected + 1, {
        name,
        description,
        config,
        ...patch,
      });
    });
  }
  copy(id: string, expected: number, name?: string) {
    return transaction(this.db, () => {
      this.writable(id, expected);
      const source = this.get(id);
      return this.fresh({
        name: name ?? `${source.name.slice(0, 195)} Copy`,
        description: source.description,
        config: source.config,
      });
    });
  }
}
