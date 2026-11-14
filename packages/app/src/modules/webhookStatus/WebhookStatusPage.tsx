import {
  Button,
  Card,
  CardContent,
  Divider,
  TextField,
  Typography,
} from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { useCallback, useEffect, useState } from 'react';

const getInitialWebhookId = () =>
  new URLSearchParams(window.location.search).get('id') ?? '';

type StatusResult = {
  statusCode: number;
  payload: unknown;
};

/**
 * Looks up webhook status through the Backstage backend
 * (GET /api/webhooks/operator/:id/status), so the browser never talks to the
 * webhook backend directly and requests carry the user's Backstage identity.
 */
export const WebhookStatusPage = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [webhookId, setWebhookId] = useState(getInitialWebhookId);
  const [result, setResult] = useState<StatusResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  const fetchStatus = useCallback(
    async (id: string) => {
      const trimmed = id.trim();
      if (!trimmed) {
        setError('Enter a webhook ID first.');
        setResult(undefined);
        return;
      }

      setIsLoading(true);
      setError(undefined);

      try {
        const baseUrl = await discoveryApi.getBaseUrl('webhooks');
        const response = await fetchApi.fetch(
          `${baseUrl}/operator/${encodeURIComponent(trimmed)}/status`,
          { headers: { accept: 'application/json' } },
        );
        const responseText = await response.text();

        let payload: unknown = responseText;
        try {
          payload = responseText ? JSON.parse(responseText) : undefined;
        } catch {
          // Preserve non-JSON response bodies for debugging.
        }

        setResult({ statusCode: response.status, payload });
        if (!response.ok) {
          setError(`Status request failed (${response.status}).`);
        }
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Unknown network error';
        setError(`Request failed: ${message}`);
        setResult(undefined);
      } finally {
        setIsLoading(false);
      }
    },
    [discoveryApi, fetchApi],
  );

  // Arriving from a scaffolder output link (?id=...): load immediately.
  useEffect(() => {
    const initialId = getInitialWebhookId();
    if (initialId) {
      fetchStatus(initialId);
    }
  }, [fetchStatus]);

  return (
    <Card>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          Webhook Status
        </Typography>
        <Typography variant="body2" color="textSecondary" paragraph>
          Check the latest status for a webhook by ID. This displays the full
          JSON response.
        </Typography>
        <form
          onSubmit={event => {
            event.preventDefault();
            fetchStatus(webhookId);
          }}
        >
          <TextField
            label="Webhook ID"
            variant="outlined"
            fullWidth
            margin="normal"
            value={webhookId}
            onChange={event => setWebhookId(event.target.value)}
            placeholder="Paste webhook id from submit response"
          />
          <Button
            type="submit"
            variant="contained"
            color="primary"
            startIcon={<RefreshIcon />}
            disabled={isLoading}
            style={{ marginTop: 8, marginBottom: 8 }}
          >
            {isLoading ? 'Refreshing...' : 'Refresh Status'}
          </Button>
        </form>

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
                { statusCode: result.statusCode, response: result.payload },
                null,
                2,
              )
            : 'No response yet. Click "Refresh Status" after entering an ID.'}
        </pre>
      </CardContent>
    </Card>
  );
};
