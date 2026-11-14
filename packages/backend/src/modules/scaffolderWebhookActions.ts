import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import {
  BACKSTAGE_HEADER_PREFIX,
  buildEventUrl,
  buildResourceUrl,
  buildStatusUrl,
  extractWebhookId,
  PRINCIPAL_HEADER,
  readResponseBody,
  readWebhookRouting,
  sendWebhook,
  TASK_ID_HEADER,
  WebhookRouting,
} from '../plugins/webhooks/client';

const MAX_ERROR_BODY_CHARS = 2000;

type WebhookRequest = {
  app: string;
  event: string;
  method: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  /** Strings are sent as-is; anything else is JSON encoded. */
  body?: unknown;
};

type WebhookCallContext = {
  taskId: string;
  userRef?: string;
  signal?: AbortSignal;
};

type WebhookResult = {
  status: number;
  targetUrl: string;
  webhookId?: string;
  statusUrl?: string;
  resourceUrl?: string;
  response?: unknown;
  responseJson?: string;
};

/** Minimal shape of ctx.output shared by both actions (method syntax keeps it assignable). */
type OutputSink = { output(name: string, value: unknown): void };

/**
 * Single code path for every webhook action: builds the URL, attaches
 * Backstage-controlled identity headers, sends (signed, with timeout), and
 * shapes the outputs.
 */
async function callWebhook(
  routing: WebhookRouting,
  request: WebhookRequest,
  context: WebhookCallContext,
): Promise<WebhookResult> {
  const targetUrl = buildEventUrl(
    routing,
    request.app,
    request.event,
    request.query,
  );

  // Template-supplied headers are trusted (templates come from the catalog),
  // except the x-backstage-* namespace, which only Backstage may set.
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!name.toLowerCase().startsWith(BACKSTAGE_HEADER_PREFIX)) {
      headers.set(name, value);
    }
  }
  headers.set(TASK_ID_HEADER, context.taskId);
  if (context.userRef) {
    headers.set(PRINCIPAL_HEADER, context.userRef);
  }

  let body: string | undefined;
  if (request.body !== undefined) {
    if (typeof request.body === 'string') {
      body = request.body;
    } else {
      body = JSON.stringify(request.body);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }
  }

  const response = await sendWebhook(routing, targetUrl, {
    method: request.method,
    headers,
    body,
    signal: context.signal,
  });
  const { text, body: responseBody } = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `Webhook request failed (${
        response.status
      }) at ${targetUrl}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
    );
  }

  const webhookId = extractWebhookId(responseBody);
  return {
    status: response.status,
    targetUrl,
    webhookId,
    statusUrl: webhookId ? buildStatusUrl(routing, webhookId) : undefined,
    resourceUrl: webhookId
      ? buildResourceUrl(routing, request.app, request.event, webhookId)
      : undefined,
    response: responseBody,
    responseJson: toResponseJson(responseBody),
  };
}

function toResponseJson(body: unknown): string | undefined {
  if (body === undefined || typeof body === 'string') {
    return body;
  }
  return JSON.stringify(body, null, 2);
}

function emitOutputs(ctx: OutputSink, result: WebhookResult) {
  for (const [name, value] of Object.entries(result)) {
    if (value !== undefined) {
      ctx.output(name, value);
    }
  }
}

const createDispatchAction = (routing: WebhookRouting) =>
  createTemplateAction({
    id: 'webhook:dispatch',
    description:
      'Dispatch an arbitrary webhook request using template-defined app/event routing. ' +
      'The initiating user and task ID are sent as x-backstage-principal / x-backstage-task-id headers.',
    schema: {
      input: {
        app: z => z.string(),
        event: z => z.string(),
        method: z =>
          z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
        headers: z => z.record(z.string()).optional(),
        query: z =>
          z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z => z.any().optional(),
      },
      output: {
        status: z => z.number(),
        targetUrl: z => z.string(),
        webhookId: z => z.string().optional(),
        statusUrl: z => z.string().optional(),
        resourceUrl: z => z.string().optional(),
        response: z => z.any().optional(),
        responseJson: z => z.string().optional(),
      },
    },
    async handler(ctx) {
      const result = await callWebhook(routing, ctx.input, {
        taskId: ctx.task.id,
        userRef: ctx.user?.ref,
        signal: ctx.signal,
      });
      emitOutputs(ctx, result);
    },
  });

const createRequestVmAction = (routing: WebhookRouting) =>
  createTemplateAction({
    id: 'webhook:request-vm',
    description: 'Request a VM through the generic webhook backend',
    schema: {
      input: {
        app: z => z.string().default('infra'),
        event: z => z.string().default('request-vm'),
        vmName: z => z.string(),
        image: z => z.string(),
        cpu: z => z.number().int().positive().default(2),
        memoryGb: z => z.number().positive().default(4),
        diskGb: z => z.number().positive().default(40),
        headers: z => z.record(z.string()).optional(),
        query: z =>
          z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        metadata: z => z.record(z.any()).optional(),
      },
      output: {
        status: z => z.number(),
        targetUrl: z => z.string(),
        webhookId: z => z.string().optional(),
        statusUrl: z => z.string().optional(),
        resourceUrl: z => z.string().optional(),
        response: z => z.any().optional(),
        responseJson: z => z.string().optional(),
      },
    },
    async handler(ctx) {
      const { app, event, headers, query, metadata } = ctx.input;
      const result = await callWebhook(
        routing,
        {
          app,
          event,
          method: 'POST',
          headers,
          query,
          body: {
            vm: {
              name: ctx.input.vmName,
              image: ctx.input.image,
              cpu: ctx.input.cpu,
              memoryGb: ctx.input.memoryGb,
              diskGb: ctx.input.diskGb,
            },
            metadata: {
              ...metadata,
              // Set server-side after the spread so templates cannot override.
              requestedBy: ctx.user?.ref,
              templateName: ctx.templateInfo?.entity?.metadata.name,
              taskId: ctx.task.id,
            },
          },
        },
        { taskId: ctx.task.id, userRef: ctx.user?.ref, signal: ctx.signal },
      );
      emitOutputs(ctx, result);
    },
  });

export const scaffolderWebhookActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'webhook-actions',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolderActions, config }) {
        const routing = readWebhookRouting(config);
        scaffolderActions.addActions(
          createDispatchAction(routing),
          createRequestVmAction(routing),
        );
      },
    });
  },
});
