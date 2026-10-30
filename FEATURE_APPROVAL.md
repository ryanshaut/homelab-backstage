Add a new template middleware called Approvals. 

It can be added to any template as a step that interuptes the existing Template workflow.

An approval has 2 parts. 
1.) Requesting an approval via an external Approval system
2.) Polling and waiting for that to be approved/rejected.


The request might be approved minutes later, or days. The system needs to persist the original template so that when a request does come it can be processed. THis includes surviving Backstage app restarts. 



On a Template submission, the workflow needs to do what's in scripts/example-approval-workflow-python.py.

```python
    webhook_session = create_webhook_session()
    callback = request_callback(webhook_session)
    access_token = get_access_token()
    send_approval_request(access_token, callback)
    wait_for_callback(webhook_session, callback["id"])
```

`request_callback()` requests a one time webhook that the approval service will call when an approval/rejection for this request is done. 
`send_approval_request()` sends an approval to the third party service that triggers the actual approval workflow. Once an approval/rejection is done, that service calls the callback url generated in the step above. 
`wait_for_callback()` - pools that above callback url and checks if the request is still pending or approve/rejected.


Required configuration keys:

WEBHOOK_BASE_URL = "https://rswebhooks.int.shaut.us"
APPROVALS_URL = "https://approveme-api.apps.shaut.us/approvals"
APPROVAL_SUBJECT = "user::me@example.com"

# used in a client credential grant token exchange.
KC_SA_PW=supersecret
KC_SA_UN=svc-account-a
KC_ODIC_DISCOVERY_URI=https://keycloak.apps.shaut.us/realms/shauthq-prod/.well-known/openid-configuration

APPROVAL_SUBJECT will be specified on the template itself, so that different templates could require approval by different people/groups.



Business Expectation:

Using examples/templates/noop-testing/template.yaml as an example:

1. We add a new step to the template, `require-approval` which uses a new action `approval:dispatch`. 
2. Backstage takes the data of the template and creates an approval using the steps above.
3. The template request stays 'in limbo' until the request is approved/rejected.
4. The state of the template moves to `pending approval`. 
5. A background job persists the original request and polls the callback url generated above and stored with the original request.
6. If the approval is rejected, cancel the template, update the status and show the response from the callback url ('reason' field)
7. If the approval is approved, proceed to the next step of the template as-if the approval step never occured.


### FROM CLAUDE

We're waiting on a manager to approve typically, so only waiting an hour or holding open a fragile worker thread aren't good design choices

Designing a scheduler-based approval record with secure resume logic.
You’re right. Don’t hold a task open for a human-speed approval. Split the flow in two: the template task submits the request and ends, and a durable background job picks it up when the approval resolves. Restarts, pod rescheduling and multi-day waits then don’t matter, because state lives in a database instead of a running worker.

Design
Run 1 (user-initiated): the gate action requests the callback URL, sends the approval request, and writes a pending row (callback URL, template ref, form values, requesting user). It outputs approved: false and the task finishes, with a link to a status page or a note saying “submitted for approval”.
Background job: a scheduler task in the backend polls the callback URL of every pending row. Because it’s a single periodic job over N rows, it survives restarts and runs on only one instance at a time, even with multiple replicas.
On approved: mark the row approved and launch a new scaffolder task for the same template with the stored values plus the approvalId.
Run 2: the gate action sees an approvalId, verifies it against the DB (approved, unused, same template), consumes it, and outputs approved: true. The real steps then run.
On rejected or expired: mark the row and optionally notify the requester.
The verification in step 4 matters. If the resume were driven by a plain approvalId parameter, users could skip approval by crafting one. Checking the DB row closes that hole.

Template
yaml
spec:
  parameters:
    - title: Details
      properties:
        name: { type: string }
        requiresApproval: { type: boolean, default: true }
        approvalId:            # set only by the resume job
          type: string
          ui:widget: hidden
  steps:
    - id: gate
      name: Approval gate
      action: acme:approval:gate
      input:
        requiresApproval: ${{ parameters.requiresApproval }}
        approvalId: ${{ parameters.approvalId }}
        summary: Create service ${{ parameters.name }}
        values: ${{ parameters }}

    - id: fetch
      name: Fetch skeleton
      if: ${{ steps.gate.output.approved }}
      action: fetch:template
      input:
        url: ./skeleton
        values: { name: ${{ parameters.name }} }
    # ...publish, register, etc., all with the same `if`
Backend module
ts
// packages/backend/src/modules/approval.ts
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { randomUUID } from 'crypto';

const TABLE = 'approval_requests';

export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'approval-gate',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        logger: coreServices.logger,
      },
      async init({ scaffolder, database, scheduler, auth, discovery, logger }) {
        const db = await database.getClient();
        if (!(await db.schema.hasTable(TABLE))) {
          await db.schema.createTable(TABLE, t => {
            t.string('id').primary();
            t.string('callback_url').notNullable();
            t.string('template_ref').notNullable();
            t.text('values').notNullable();
            t.string('user_ref').notNullable();
            t.string('status').notNullable(); // pending|approved|rejected|expired|consumed
            t.timestamp('created_at').defaultTo(db.fn.now());
          });
        }

        const gate = createTemplateAction({
          id: 'acme:approval:gate',
          schema: {
            input: {
              requiresApproval: z => z.boolean(),
              approvalId: z => z.string().optional(),
              summary: z => z.string(),
              values: z => z.record(z.any()),
            },
            output: { approved: z => z.boolean() },
          },
          async handler(ctx) {
            const { requiresApproval, approvalId, summary, values } = ctx.input;

            if (!requiresApproval) return ctx.output('approved', true);

            // Run 2: resume. Verify against the DB, never trust the parameter.
            if (approvalId) {
              const consumed = await db(TABLE)
                .where({ id: approvalId, status: 'approved', template_ref: ctx.templateInfo?.entityRef })
                .update({ status: 'consumed' });
              if (!consumed) throw new Error('Invalid or already-used approval');
              return ctx.output('approved', true);
            }

            // Run 1: submit and stop.
            const id = randomUUID();
            const callbackUrl = await ctx.checkpoint({
              key: 'callback',
              fn: async () => {
                const r = await fetch('https://callback-system.internal/callbacks', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${process.env.CALLBACK_TOKEN}` },
                });
                if (!r.ok) throw new Error(`Callback request failed: ${r.status}`);
                return (await r.json()).url as string;
              },
            });

            await db(TABLE).insert({
              id,
              callback_url: callbackUrl,
              template_ref: ctx.templateInfo!.entityRef,
              values: JSON.stringify(values),
              user_ref: ctx.user?.ref ?? 'unknown',
              status: 'pending',
            });

            await ctx.checkpoint({
              key: 'approval-request',
              fn: async () => {
                const r = await fetch('https://approvals.internal/api/requests', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.APPROVAL_TOKEN}`,
                  },
                  body: JSON.stringify({ requester: ctx.user?.ref, summary, callbackUrl }),
                });
                if (!r.ok) throw new Error(`Approval request failed: ${r.status}`);
                return true;
              },
            });

            ctx.logger.info(`Submitted for approval (id ${id}). Provisioning will start once approved.`);
            ctx.output('approved', false);
          },
        });
        scaffolder.addActions(gate);

        // The durable poller
        await scheduler.scheduleTask({
          id: 'approval-poller',
          frequency: { minutes: 1 },
          timeout: { minutes: 5 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            const pending = await db(TABLE).where({ status: 'pending' });
            for (const row of pending) {
              try {
                const res = await fetch(row.callback_url);
                if (!res.ok) continue;
                const { status } = await res.json(); // adjust to your payload

                if (status === 'rejected') {
                  await db(TABLE).where({ id: row.id }).update({ status: 'rejected' });
                  // notify requester here
                } else if (status === 'approved') {
                  await db(TABLE).where({ id: row.id }).update({ status: 'approved' });
                  await launchTask(row);
                }
              } catch (e) {
                logger.warn(`Poll failed for ${row.id}: ${e}`);
              }
            }
            // Optional: expire anything pending for more than N days
          },
        });

        async function launchTask(row: any) {
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'scaffolder',
          });
          const base = await discovery.getBaseUrl('scaffolder');
          const res = await fetch(`${base}/v2/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              templateRef: row.template_ref,
              values: { ...JSON.parse(row.values), approvalId: row.id },
            }),
          });
          if (!res.ok) throw new Error(`Task launch failed: ${res.status}`);
        }
      },
    });
  },
});
Caveats
Identity on the resumed run: a task created with service credentials doesn’t carry the original user, so user.entity and ctx.user will be empty in run 2. Either pass userRef through the values (the gate stores user_ref for this) and use it in later steps, or have your own endpoint create the task with the user’s identity if your Backstage version supports impersonation. Check what your version allows, since this part of the scaffolder API has changed across releases.
Idempotency of the launch: if the job crashes between marking approved and the task launching, you’d stall. If that’s a concern, add a launched state and retry rows that are approved but not yet launched. The consumed check in run 2 already prevents double execution.
Remove the poller if you can: if the approval system can send a webhook on decision, add a small backend route that updates the row and launches the task, and keep the scheduler as a fallback. That’s lower latency and less polling load, but the scheduler version works with what you described.
Status visibility: users will want to see where their request stands. A simple read endpoint over this table, or a Backstage notification when the state changes (@backstage/plugin-notifications), makes the “task finished but nothing happened yet” experience much less confusing.
Heavier alternative: if approvals grow into multi-stage flows with escalations and timeouts, a workflow engine like Temporal handles the wait natively. For a single manager approval, the table plus scheduler is far less machinery.
If you tell me which Backstage version you’re on and whether the approval service can send webhooks, I can tighten the user-identity handling and the launch step.

Its a newer version, probably from the last few months. My approval service calls a predefined URL (part of original request payload) on approval/rejection.

Securing the webhook secret and designing idempotent task launching.
With a webhook available, the poller goes away. The approval service posts the decision, a route in the backend updates the row and launches the resume task, and a small scheduled sweep remains only as a safety net.

What changes
Drop the callback system. Put a Backstage webhook URL in the approval request payload instead. Per-request ids and secrets give you the unique callback, and the database row replaces the stored URL. Keep the callback system only if the approval service can’t reach Backstage over the network. In that case, polling it from the scheduler is still the fallback.
The webhook must be unauthenticated at the Backstage layer, because the approval service has no Backstage token. The URL contains a random per-request secret, and you store only its hash. If the approval service can sign payloads with HMAC, verify that too.
Decision handling is idempotent. An atomic pending → approved update means duplicate or replayed webhooks can only launch one task.
The sweep retries launches that failed after approval and expires old pending rows. It makes no external calls except the launch retry.
Changes to the module
The template YAML stays as is. In the module, the table gets a secret_hash column, and the status flow becomes pending → approved → launched → consumed (or rejected / expired).

ts
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import Router from 'express-promise-router';
import express from 'express';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'crypto';

const TABLE = 'approval_requests';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'approval-gate',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
      },
      async init({ scaffolder, database, scheduler, auth, discovery, logger, config, httpRouter }) {
        const db = await database.getClient();
        if (!(await db.schema.hasTable(TABLE))) {
          await db.schema.createTable(TABLE, t => {
            t.string('id').primary();
            t.string('secret_hash').notNullable();
            t.string('template_ref').notNullable();
            t.text('values').notNullable();
            t.string('user_ref').notNullable();
            t.string('status').notNullable();
            t.timestamp('created_at').defaultTo(db.fn.now());
          });
        }

        const baseUrl = config.getString('backend.baseUrl'); // must be reachable by the approval service

        // ---------- Gate action ----------
        scaffolder.addActions(
          createTemplateAction({
            id: 'acme:approval:gate',
            schema: {
              input: {
                requiresApproval: z => z.boolean(),
                approvalId: z => z.string().optional(),
                summary: z => z.string(),
                values: z => z.record(z.any()),
              },
              output: { approved: z => z.boolean() },
            },
            async handler(ctx) {
              const { requiresApproval, approvalId, summary, values } = ctx.input;
              if (!requiresApproval) return ctx.output('approved', true);

              // Run 2: only a row the webhook approved AND the launcher issued
              if (approvalId) {
                const n = await db(TABLE)
                  .where({ id: approvalId, status: 'launched', template_ref: ctx.templateInfo?.entityRef })
                  .update({ status: 'consumed' });
                if (!n) throw new Error('Invalid or already-used approval');
                return ctx.output('approved', true);
              }

              // Run 1: record, notify approval service, end
              const id = await ctx.checkpoint({
                key: 'submit',
                fn: async () => {
                  const id = randomUUID();
                  const secret = randomBytes(32).toString('hex');
                  await db(TABLE).insert({
                    id,
                    secret_hash: sha256(secret),
                    template_ref: ctx.templateInfo!.entityRef,
                    values: JSON.stringify(values),
                    user_ref: ctx.user?.ref ?? 'unknown',
                    status: 'pending',
                  });
                  try {
                    const r = await fetch('https://approvals.internal/api/requests', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${process.env.APPROVAL_TOKEN}`,
                      },
                      body: JSON.stringify({
                        requester: ctx.user?.ref,
                        summary,
                        callbackUrl: `${baseUrl}/api/scaffolder/approval-webhook/${id}/${secret}`,
                      }),
                    });
                    if (!r.ok) throw new Error(`Approval request failed: ${r.status}`);
                  } catch (e) {
                    await db(TABLE).where({ id }).delete();
                    throw e;
                  }
                  return id;
                },
              });
              ctx.logger.info(`Submitted for approval (${id}). Provisioning starts once approved.`);
              ctx.output('approved', false);
            },
          }),
        );

        // ---------- Launch helper ----------
        async function tryLaunch(row: any) {
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'scaffolder',
          });
          const base = await discovery.getBaseUrl('scaffolder');
          const res = await fetch(`${base}/v2/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              templateRef: row.template_ref,
              values: { ...JSON.parse(row.values), approvalId: row.id },
            }),
          });
          if (!res.ok) throw new Error(`Task launch failed: ${res.status}`);
          await db(TABLE).where({ id: row.id, status: 'approved' }).update({ status: 'launched' });
        }

        // ---------- Webhook ----------
        httpRouter.addAuthPolicy({ path: '/approval-webhook', allow: 'unauthenticated' });

        const router = Router();
        router.post('/approval-webhook/:id/:secret', express.json(), async (req, res) => {
          const { id, secret } = req.params;
          const row = await db(TABLE).where({ id }).first();
          if (!row || !safeEqual(sha256(secret), row.secret_hash)) {
            return res.status(404).end(); // don't reveal which part was wrong
          }

          const decision = req.body?.status; // adjust to your approval service's payload
          if (decision === 'rejected') {
            await db(TABLE).where({ id, status: 'pending' }).update({ status: 'rejected' });
            // notify requester here
          } else if (decision === 'approved') {
            const won = await db(TABLE).where({ id, status: 'pending' }).update({ status: 'approved' });
            if (won) {
              try {
                await tryLaunch(row);
              } catch (e) {
                logger.warn(`Launch failed for ${id}, sweep will retry: ${e}`);
              }
            }
          }
          return res.status(200).end(); // always 200 on a valid call so the sender doesn't retry-storm
        });
        httpRouter.use(router);

        // ---------- Safety-net sweep (no external polling) ----------
        await scheduler.scheduleTask({
          id: 'approval-sweep',
          frequency: { minutes: 5 },
          timeout: { minutes: 2 },
          fn: async () => {
            for (const row of await db(TABLE).where({ status: 'approved' })) {
              try { await tryLaunch(row); } catch (e) { logger.warn(`Retry launch ${row.id}: ${e}`); }
            }
            const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
            await db(TABLE).where({ status: 'pending' }).andWhere('created_at', '<', cutoff)
              .update({ status: 'expired' });
          },
        });
      },
    });
  },
});
Things to verify on your version
Route placement: registering the webhook from a scaffolder module puts it at /api/scaffolder/approval-webhook/.... That should work since modules share the plugin’s httpRouter, but if your version objects, move the DB and webhook into a small standalone backend plugin (e.g. approvals) and have the scaffolder module talk to it. The webhook URL then becomes /api/approvals/....
Task creation: recent releases have been adding a scaffolder service ref in @backstage/plugin-scaffolder-node for creating tasks in-process. If yours has it, use it instead of the raw /v2/tasks fetch. Either way, the resumed task runs under service credentials unless your version supports creating tasks on behalf of the original user. The stored user_ref is there so later steps can still attribute the work.
Payload shape: I assumed { status: 'approved' | 'rejected' }. Adjust it to what your approval service sends, and add signature verification if it supports signing.
Reachability: backend.baseUrl has to be resolvable from the approval service, and your ingress must allow unauthenticated POSTs to that path.
Secret hygiene: the callback URL contains a secret, so keep it out of logs, and mask it in any proxy or ingress access logs.