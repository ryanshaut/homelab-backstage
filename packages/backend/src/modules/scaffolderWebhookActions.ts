import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';

type ActionDeps = {
  rootConfig: {
    getOptionalString(key: string): string | undefined;
  };
};

const getWebhookRouting = (rootConfig: ActionDeps['rootConfig']) => {
  const configuredBaseUrl = rootConfig.getOptionalString('webhooks.baseUrl');
  const baseUrl = (configuredBaseUrl ?? 'http://localhost:3001/api/webhooks').replace(
    /\/$/,
    '',
  );

  const configuredTenant = rootConfig.getOptionalString('webhooks.tenant');
  const authEnv = rootConfig.getOptionalString('auth.environment') ?? 'development';
  const tenant = configuredTenant ?? `backstage-${authEnv}`;

  return { baseUrl, tenant };
};

const buildTargetUrl = (
  baseUrl: string,
  tenant: string,
  app: string,
  event: string,
  query?: Record<string, string | number | boolean>,
) => {
  const queryString = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      queryString.append(key, String(value));
    }
  }

  return `${baseUrl}/${encodeURIComponent(tenant)}/${encodeURIComponent(app)}/${encodeURIComponent(event)}${queryString.toString() ? `?${queryString.toString()}` : ''}`;
};

const buildResourceUrl = (
  baseUrl: string,
  tenant: string,
  app: string,
  event: string,
  responseBody: unknown,
): string | undefined => {
  const id =
    responseBody &&
    typeof responseBody === 'object' &&
    'id' in responseBody &&
    typeof (responseBody as { id?: unknown }).id === 'string'
      ? (responseBody as { id: string }).id
      : undefined;

  if (!id) {
    return undefined;
  }

  return `${baseUrl}/${encodeURIComponent(tenant)}/${encodeURIComponent(app)}/${encodeURIComponent(event)}/${encodeURIComponent(id)}`;
};

const createDispatchAction = ({ rootConfig }: ActionDeps) =>
  createTemplateAction({
    id: 'webhook:dispatch',
    description:
      'Dispatch an arbitrary webhook request using template-defined app/event routing',
    schema: {
      input: {
        app: z => z.string(),
        event: z => z.string(),
        method: z =>
          z
            .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
            .default('POST'),
        headers: z => z.record(z.string()).optional(),
        query: z =>
          z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z => z.any().optional(),
      },
      output: {
        status: z => z.number(),
        targetUrl: z => z.string(),
        resourceUrl: z => z.string().optional(),
        response: z => z.any().optional(),
      },
    },
    async handler(ctx) {
      const { baseUrl, tenant } = getWebhookRouting(rootConfig);
      const targetUrl = buildTargetUrl(
        baseUrl,
        tenant,
        ctx.input.app,
        ctx.input.event,
        ctx.input.query,
      );

      const headers: Record<string, string> = {
        ...(ctx.input.headers ?? {}),
      };

      let requestBody: string | undefined;
      if (ctx.input.body !== undefined) {
        if (typeof ctx.input.body === 'string') {
          requestBody = ctx.input.body;
        } else {
          requestBody = JSON.stringify(ctx.input.body);
          if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
            headers['content-type'] = 'application/json';
          }
        }
      }

      const response = await fetch(targetUrl, {
        method: ctx.input.method,
        headers,
        body: ['GET', 'HEAD'].includes(ctx.input.method)
          ? undefined
          : requestBody,
      });

      const responseText = await response.text();
      let responseBody: unknown = responseText;
      try {
        responseBody = responseText ? JSON.parse(responseText) : undefined;
      } catch {
        // Keep plain text response when upstream does not return JSON.
      }

      if (!response.ok) {
        throw new Error(
          `Webhook request failed (${response.status}) at ${targetUrl}: ${responseText}`,
        );
      }

      const resourceUrl = buildResourceUrl(
        baseUrl,
        tenant,
        ctx.input.app,
        ctx.input.event,
        responseBody,
      );

      ctx.output('status', response.status);
      ctx.output('targetUrl', targetUrl);
      if (resourceUrl) {
        ctx.output('resourceUrl', resourceUrl);
      }
      ctx.output('response', responseBody);
    },
  });

const createRequestVmAction = ({ rootConfig }: ActionDeps) =>
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
        query: z => z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        metadata: z => z.record(z.any()).optional(),
      },
      output: {
        status: z => z.number(),
        targetUrl: z => z.string(),
        resourceUrl: z => z.string().optional(),
        response: z => z.any().optional(),
      },
    },
    async handler(ctx) {
      const { baseUrl, tenant } = getWebhookRouting(rootConfig);
      const targetUrl = buildTargetUrl(
        baseUrl,
        tenant,
        ctx.input.app,
        ctx.input.event,
        ctx.input.query,
      );

      const payload = {
        vm: {
          name: ctx.input.vmName,
          image: ctx.input.image,
          cpu: ctx.input.cpu,
          memoryGb: ctx.input.memoryGb,
          diskGb: ctx.input.diskGb,
        },
        metadata: {
          ...ctx.input.metadata,
          templateName: ctx.templateInfo?.entity?.metadata.name,
          taskId: ctx.task.id,
        },
      };

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ctx.input.headers ?? {}),
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      let responseBody: unknown = responseText;
      try {
        responseBody = responseText ? JSON.parse(responseText) : undefined;
      } catch {
        // Keep plain text response when upstream does not return JSON.
      }

      if (!response.ok) {
        throw new Error(
          `VM request failed (${response.status}) at ${targetUrl}: ${responseText}`,
        );
      }

      const resourceUrl = buildResourceUrl(
        baseUrl,
        tenant,
        ctx.input.app,
        ctx.input.event,
        responseBody,
      );

      ctx.output('status', response.status);
      ctx.output('targetUrl', targetUrl);
      if (resourceUrl) {
        ctx.output('resourceUrl', resourceUrl);
      }
      ctx.output('response', responseBody);
    },
  });

export const scaffolderWebhookActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'webhook-actions',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        rootConfig: coreServices.rootConfig,
      },
      async init({ scaffolderActions, rootConfig }) {
        scaffolderActions.addActions(
          createDispatchAction({ rootConfig }),
          createRequestVmAction({ rootConfig }),
        );
      },
    });
  },
});
