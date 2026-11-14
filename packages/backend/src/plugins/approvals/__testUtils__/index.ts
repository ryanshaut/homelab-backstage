/* Test helpers for the approvals plugin (imported only by *.test.ts files). */
import type {
  DatabaseService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { NotFoundError } from '@backstage/errors';
import knexFactory from 'knex';
import {
  ApprovalRecord,
  ApprovalRequestCreate,
  ApprovalsClient,
  ApprovalsConfig,
} from '../client';

export const SECRET = 'test-signing-secret-0123456789abcdefghij';

export const testConfig: ApprovalsConfig = {
  baseUrl: 'http://approvals',
  source: 'backstage-test',
  callbackBaseUrl: 'https://backstage.example.com',
  signingSecret: SECRET,
  requestTimeoutMs: 1000,
  auth: { metadataUrl: 'http://oidc', clientId: 'c', clientSecret: 's' },
};

export const testLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => testLogger,
} as unknown as LoggerService;

/** In-memory stand-in for the approval API, sharing ApprovalsClient's interface. */
export class FakeApprovals {
  records = new Map<number, ApprovalRecord>();
  creates: ApprovalRequestCreate[] = [];
  updates: { id: number; update: Partial<ApprovalRecord> }[] = [];
  nextId = 42;
  config = testConfig;

  asClient(): ApprovalsClient {
    return this as unknown as ApprovalsClient;
  }

  async createApproval(request: ApprovalRequestCreate) {
    this.creates.push(request);
    const existing = [...this.records.values()].find(
      r => r.idepotency_id === request.idepotency_id,
    );
    if (existing) {
      return { record: existing, created: false };
    }
    const record: ApprovalRecord = {
      id: this.nextId++,
      idepotency_id: request.idepotency_id,
      source: request.source,
      status: 'pending',
      substatus: 'none',
      approval_subject: request.approval_subject,
      requested_by: request.requested_by ?? null,
      reason: null,
      data: request.data,
      callback_url: request.callback_url ?? null,
      callback_method: request.callback_method ?? null,
      created_at: '2026-11-13T00:00:00Z',
      updated_at: '2026-11-13T00:00:00Z',
    };
    this.records.set(record.id, record);
    return { record, created: true };
  }

  async updateApproval(id: number, update: Partial<ApprovalRecord>) {
    this.updates.push({ id, update });
    const record = { ...this.records.get(id)!, ...update };
    this.records.set(id, record);
    return record;
  }

  async getApproval(id: number) {
    const record = this.records.get(id);
    if (!record || record.source !== this.config.source) {
      throw new NotFoundError(`Approval ${id} not found`);
    }
    return record;
  }

  async getAudit() {
    return [];
  }

  decide(id: number, status: string, reason?: string) {
    const record = this.records.get(id)!;
    this.records.set(id, { ...record, status, reason: reason ?? null });
  }
}

/** A DatabaseService backed by a fresh in-memory SQLite database. */
export function testDatabase(): DatabaseService {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });
  return { getClient: async () => knex } as unknown as DatabaseService;
}
