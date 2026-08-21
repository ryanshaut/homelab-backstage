import { Button, Card, CardContent, Divider, TextField, Typography } from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { configApiRef, useApi } from '@backstage/frontend-plugin-api';
import { useCallback, useMemo, useState } from 'react';

const getInitialWebhookId = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URLSearchParams(window.location.search).get('id') ?? '';
};

const getInitialStatusUrl = () => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return new URLSearchParams(window.location.search).get('statusUrl') ?? undefined;
};

type StatusResult = {
  statusCode: number;
  payload: unknown;
};

export const WebhookStatusPage = () => {
  const configApi = useApi(configApiRef);
  const [webhookId, setWebhookId] = useState(getInitialWebhookId);
  const [explicitStatusUrl, setExplicitStatusUrl] = useState<string | undefined>(
    getInitialStatusUrl,
  );
  const [result, setResult] = useState<StatusResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  const operatorBaseUrl = useMemo(() => {
    const configuredBaseUrl = configApi.getOptionalString('webhooks.baseUrl') ?? '';
    const normalizedBaseUrl = configuredBaseUrl
      .replace(/\/$/, '')
      .replace(/\/api\/webhooks\/?$/, '');

    return normalizedBaseUrl;
  }, [configApi]);

  const statusUrl = useMemo(() => {
    if (explicitStatusUrl) {
      return explicitStatusUrl;
    }

    if (!webhookId.trim()) {
      return undefined;
    }

    if (!operatorBaseUrl) {
      return `/api/operator/webhooks/${encodeURIComponent(webhookId.trim())}/status`;
    }

    return `${operatorBaseUrl}/api/operator/webhooks/${encodeURIComponent(webhookId.trim())}/status`;
  }, [explicitStatusUrl, operatorBaseUrl, webhookId]);

  const fetchStatus = useCallback(async () => {
    if (!statusUrl) {
      setError('Enter a webhook ID first.');
      setResult(undefined);
      return;
    }

    setIsLoading(true);
    setError(undefined);

    try {
      const response = await fetch(statusUrl);
      const responseText = await response.text();

      let payload: unknown = responseText;
      try {
        payload = responseText ? JSON.parse(responseText) : undefined;
      } catch {
        // Preserve non-JSON response bodies for debugging.
      }

      setResult({
        statusCode: response.status,
        payload,
      });

      if (!response.ok) {
        setError(`Status request failed (${response.status}).`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown network error';
      setError(`Request failed: ${message}`);
      setResult(undefined);
    } finally {
      setIsLoading(false);
    }
  }, [statusUrl]);

  return (
    <Card>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          Webhook Status
        </Typography>
        <Typography variant="body2" color="textSecondary" paragraph>
          Check the latest status for a webhook by ID. This displays the full JSON response.
        </Typography>
        <TextField
          label="Webhook ID"
          variant="outlined"
          fullWidth
          margin="normal"
          value={webhookId}
          onChange={event => {
            setWebhookId(event.target.value);
            setExplicitStatusUrl(undefined);
          }}
          placeholder="Paste webhook id from submit response"
        />
        <div style={{ display: 'flex', gap: 12, marginTop: 8, marginBottom: 8 }}>
          <Button
            variant="contained"
            color="primary"
            startIcon={<RefreshIcon />}
            onClick={fetchStatus}
            disabled={isLoading}
          >
            {isLoading ? 'Refreshing...' : 'Refresh Status'}
          </Button>
          {statusUrl && (
            <Button
              variant="outlined"
              color="default"
              startIcon={<OpenInNewIcon />}
              href={statusUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Endpoint
            </Button>
          )}
        </div>

        {error && (
          <Typography color="error" paragraph>
            {error}
          </Typography>
        )}

        <Divider style={{ marginTop: 16, marginBottom: 16 }} />

        <Typography variant="subtitle2" gutterBottom>
          Raw Response JSON
        </Typography>
        <pre
          style={{
            margin: 0,
            maxHeight: 480,
            overflow: 'auto',
            background: '#f6f8fa',
            borderRadius: 4,
            padding: 12,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {result
            ? JSON.stringify(
                {
                  statusCode: result.statusCode,
                  response: result.payload,
                },
                null,
                2,
              )
            : 'No response yet. Click "Refresh Status" after entering an ID.'}
        </pre>
      </CardContent>
    </Card>
  );
};
