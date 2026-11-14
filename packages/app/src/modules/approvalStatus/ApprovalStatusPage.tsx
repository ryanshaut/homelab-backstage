import {
  CodeSnippet,
  InfoCard,
  Link,
  StatusError,
  StatusOK,
  StatusPending,
  StatusWarning,
  StructuredMetadataTable,
  Table,
} from '@backstage/core-components';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { Box, Button, Grid, TextField, Typography } from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import { useCallback, useEffect, useState } from 'react';

/** Mirrors ApprovalStatusResponse from the backend approvals plugin. */
type ApprovalStatus = {
  id: number;
  state: 'pending' | 'approved' | 'rejected' | 'unknown';
  status: string;
  substatus: string;
  reason?: string;
  approver: string;
  requestedBy?: string;
  title?: string;
  description?: string;
  links: { label: string; url: string }[];
  createdAt: string;
  updatedAt: string;
  audit: {
    id: number;
    action: string;
    performed_by: string;
    reason?: string | null;
    created_at: string;
  }[];
  continuation?: {
    templateRef: string;
    requestedBy?: string;
    status: 'waiting' | 'launching' | 'launched' | 'failed' | 'rejected';
    taskId?: string;
    error?: string;
  };
  record: unknown;
};

/** While pending, re-check this often. */
const AUTO_REFRESH_MS = 15_000;

/** True while something may still change without user action. */
const isInFlight = (approval: ApprovalStatus) =>
  approval.state === 'pending' ||
  approval.continuation?.status === 'waiting' ||
  approval.continuation?.status === 'launching';

const ContinuationStatus = ({ approval }: { approval: ApprovalStatus }) => {
  const c = approval.continuation!;
  switch (c.status) {
    case 'launched':
      return (
        <StatusOK>
          Started:{' '}
          <Link to={`/create/tasks/${c.taskId}`}>view task {c.taskId}</Link>
        </StatusOK>
      );
    case 'launching':
      return <StatusPending>Starting…</StatusPending>;
    case 'failed':
      return <StatusError>Approved, but failed to start</StatusError>;
    case 'rejected':
      return <StatusError>Not started: approval was rejected</StatusError>;
    default:
      if (approval.state === 'rejected') {
        return <StatusError>Will not run: approval was rejected</StatusError>;
      }
      return approval.state === 'approved' ? (
        <StatusPending>
          Approved; waiting for the approval callback
        </StatusPending>
      ) : (
        <StatusPending>Starts automatically once approved</StatusPending>
      );
  }
};

const getInitialId = () =>
  new URLSearchParams(window.location.search).get('id') ?? '';

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const StateLabel = ({ approval }: { approval: ApprovalStatus }) => {
  const label = approval.substatus
    ? `${approval.status} (${approval.substatus})`
    : approval.status;
  switch (approval.state) {
    case 'approved':
      return <StatusOK>{label}</StatusOK>;
    case 'rejected':
      return <StatusError>{label}</StatusError>;
    case 'pending':
      return <StatusPending>{label}</StatusPending>;
    default:
      return <StatusWarning>{label}</StatusWarning>;
  }
};

/**
 * Shows an approval requested by the `approval:request` scaffolder action,
 * read through GET /api/approvals/:id. Auto-refreshes while pending.
 */
export const ApprovalStatusPage = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [idInput, setIdInput] = useState(getInitialId);
  const [approval, setApproval] = useState<ApprovalStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(
    async (rawId: string) => {
      const id = rawId.trim();
      if (!/^\d+$/.test(id)) {
        setError('Enter a numeric approval ID.');
        setApproval(undefined);
        return;
      }
      setIsLoading(true);
      setError(undefined);
      try {
        const baseUrl = await discoveryApi.getBaseUrl('approvals');
        const response = await fetchApi.fetch(`${baseUrl}/${id}`);
        if (!response.ok) {
          const body = await response.json().catch(() => undefined);
          setError(
            body?.error?.message ??
              `Approval lookup failed (${response.status}).`,
          );
          setApproval(undefined);
          return;
        }
        setApproval(await response.json());
      } catch (e) {
        setError(
          `Request failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setIsLoading(false);
      }
    },
    [discoveryApi, fetchApi],
  );

  useEffect(() => {
    const initialId = getInitialId();
    if (initialId) {
      load(initialId);
    }
  }, [load]);

  const [retryMessage, setRetryMessage] = useState<string | undefined>();
  const retry = useCallback(async () => {
    if (!approval) return;
    setRetryMessage(undefined);
    const baseUrl = await discoveryApi.getBaseUrl('approvals');
    const response = await fetchApi.fetch(`${baseUrl}/${approval.id}/retry`, {
      method: 'POST',
    });
    const body = await response.json().catch(() => undefined);
    setRetryMessage(
      response.ok
        ? `Retry result: ${body?.status ?? 'ok'}`
        : body?.error?.message ?? `Retry failed (${response.status})`,
    );
    await load(String(approval.id));
  }, [approval, discoveryApi, fetchApi, load]);

  // Poll while the decision or the continuation launch is outstanding.
  useEffect(() => {
    if (!approval || !isInFlight(approval)) {
      return undefined;
    }
    const timer = setInterval(() => load(String(approval.id)), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [approval, load]);

  return (
    <Box p={3}>
      <Grid container spacing={3}>
        <Grid item xs={12}>
          <InfoCard title="Approval Status">
            <Typography variant="body2" color="textSecondary">
              Look up an approval requested by a Backstage template. Pending
              approvals refresh automatically.
            </Typography>
            <form
              onSubmit={event => {
                event.preventDefault();
                load(idInput);
              }}
            >
              <TextField
                label="Approval ID"
                variant="outlined"
                fullWidth
                margin="normal"
                value={idInput}
                onChange={event => setIdInput(event.target.value)}
                placeholder="e.g. 42"
              />
              <Button
                type="submit"
                variant="contained"
                color="primary"
                startIcon={<RefreshIcon />}
                disabled={isLoading}
              >
                {isLoading ? 'Loading...' : 'Refresh'}
              </Button>
            </form>
            {error && (
              <Box mt={2}>
                <Typography color="error">{error}</Typography>
              </Box>
            )}
          </InfoCard>
        </Grid>

        {approval && (
          <>
            <Grid item xs={12} md={6}>
              <InfoCard
                title={approval.title ?? `Approval #${approval.id}`}
                subheader={approval.description}
              >
                <StructuredMetadataTable
                  metadata={{
                    'Approval ID': approval.id,
                    State: <StateLabel approval={approval} />,
                    Approver: approval.approver,
                    'Requested by': approval.requestedBy ?? '—',
                    Reason: approval.reason ?? '—',
                    Created: formatDate(approval.createdAt),
                    Updated: formatDate(approval.updatedAt),
                  }}
                />
                {approval.links.length > 0 && (
                  <Box mt={2}>
                    {approval.links.map(link => (
                      <Typography key={link.url} variant="body2">
                        <Link to={link.url}>{link.label}</Link>
                      </Typography>
                    ))}
                  </Box>
                )}
              </InfoCard>
            </Grid>

            <Grid item xs={12} md={6}>
              <Table
                title="Audit trail"
                options={{ paging: false, search: false, padding: 'dense' }}
                data={approval.audit}
                columns={[
                  {
                    title: 'When',
                    field: 'created_at',
                    render: row => formatDate(row.created_at),
                  },
                  { title: 'Action', field: 'action' },
                  { title: 'By', field: 'performed_by' },
                  {
                    title: 'Reason',
                    field: 'reason',
                    render: row => row.reason ?? '',
                  },
                ]}
                emptyContent={
                  <Box p={2}>
                    <Typography variant="body2">No audit entries.</Typography>
                  </Box>
                }
              />
            </Grid>

            {approval.continuation && (
              <Grid item xs={12}>
                <InfoCard
                  title="After approval"
                  subheader="The rest of the request runs as a new Backstage task once approved."
                >
                  <StructuredMetadataTable
                    metadata={{
                      Status: <ContinuationStatus approval={approval} />,
                      Template: approval.continuation.templateRef,
                      'Requested by': approval.continuation.requestedBy ?? '—',
                      ...(approval.continuation.error && {
                        Error: approval.continuation.error,
                      }),
                    }}
                  />
                  {approval.continuation.status === 'failed' && (
                    <Box mt={2}>
                      <Button
                        variant="outlined"
                        color="primary"
                        onClick={retry}
                      >
                        Retry start
                      </Button>
                      {retryMessage && (
                        <Typography variant="body2">{retryMessage}</Typography>
                      )}
                    </Box>
                  )}
                </InfoCard>
              </Grid>
            )}

            <Grid item xs={12}>
              <InfoCard title="Raw approval record">
                <CodeSnippet
                  language="json"
                  text={JSON.stringify(approval.record, null, 2)}
                />
              </InfoCard>
            </Grid>
          </>
        )}
      </Grid>
    </Box>
  );
};
