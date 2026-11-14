import type { DatabaseService } from '@backstage/backend-plugin-api';

type Knex = Awaited<ReturnType<DatabaseService['getClient']>>;

const TABLE = 'approval_continuations';

export type ContinuationStatus =
  | 'launching'
  | 'launched'
  | 'failed'
  | 'rejected';

export type ContinuationRow = {
  approval_id: number;
  status: ContinuationStatus;
  template_ref: string | null;
  task_id: string | null;
  reason: string | null;
  error: string | null;
  updated_at: string;
};

/**
 * Tracks what happened after each approval decision. Its main job is
 * once-only launching: the approval system (or anyone holding the callback
 * URL) may call back more than once, but only one continuation task starts.
 *
 * The approval system remains the source of truth for the decision itself;
 * losing this table (e.g. in-memory SQLite restart) only loses launch history.
 */
export class ContinuationStore {
  private constructor(private readonly db: Knex) {}

  static async create(database: DatabaseService): Promise<ContinuationStore> {
    const db = await database.getClient();
    if (!(await db.schema.hasTable(TABLE))) {
      await db.schema.createTable(TABLE, table => {
        table.integer('approval_id').primary();
        table.string('status', 16).notNullable();
        table.string('template_ref', 512);
        table.string('task_id', 64);
        table.text('reason');
        table.text('error');
        table.string('updated_at', 32).notNullable();
      });
    }
    return new ContinuationStore(db);
  }

  async get(approvalId: number): Promise<ContinuationRow | undefined> {
    return this.db<ContinuationRow>(TABLE)
      .where({ approval_id: approvalId })
      .first();
  }

  /**
   * Claims the right to launch. True for the first approved callback, or when
   * retrying a previously failed launch; false if already launched/launching.
   */
  async claimLaunch(
    approvalId: number,
    templateRef: string,
    reason: string | undefined,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await this.db(TABLE).insert({
        approval_id: approvalId,
        status: 'launching',
        template_ref: templateRef,
        reason: reason ?? null,
        updated_at: now,
      });
      return true;
    } catch (insertError) {
      const updated = await this.db(TABLE)
        .where({ approval_id: approvalId, status: 'failed' })
        .update({ status: 'launching', error: null, updated_at: now });
      if (updated > 0) {
        return true;
      }
      if (!(await this.get(approvalId))) {
        throw insertError; // not a conflict: a real database error
      }
      return false;
    }
  }

  async markLaunched(approvalId: number, taskId: string) {
    await this.db(TABLE)
      .where({ approval_id: approvalId })
      .update({
        status: 'launched',
        task_id: taskId,
        updated_at: new Date().toISOString(),
      });
  }

  async markFailed(approvalId: number, error: string) {
    await this.db(TABLE)
      .where({ approval_id: approvalId })
      .update({
        status: 'failed',
        error: error.slice(0, 2000),
        updated_at: new Date().toISOString(),
      });
  }

  /** Records a rejection; no-op if a row already exists. */
  async markRejected(approvalId: number, templateRef: string, reason?: string) {
    try {
      await this.db(TABLE).insert({
        approval_id: approvalId,
        status: 'rejected',
        template_ref: templateRef,
        reason: reason ?? null,
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Already recorded (duplicate callback).
    }
  }
}
