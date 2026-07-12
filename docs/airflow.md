# Airflow Integration

## Overview

The Airflow integration uses
[`@backstage-community/plugin-apache-airflow`](https://github.com/backstage/community-plugins/tree/main/workspaces/apache-airflow)
to surface DAG run status on Backstage entity pages.

Because Airflow's REST API requires authentication, the Backstage **proxy**
backend is used to forward requests — credentials are injected at the backend
so they are never exposed to the browser.

## Configuration

### app-config.yaml

```yaml
proxy:
  endpoints:
    /airflow:
      target: ${AIRFLOW_BASE_URL}     # e.g. http://airflow:8080/api/v1
      changeOrigin: true
      headers:
        Authorization: Basic ${AIRFLOW_BASIC_AUTH_BASE64}
```

`AIRFLOW_BASIC_AUTH_BASE64` is the Base64-encoded `username:password` string.
Generate it with:

```bash
echo -n "admin:admin" | base64
# → YWRtaW46YWRtaW4=
```

## Entity annotations

Add the following annotation to a `Component` entity to link it to an Airflow
DAG:

```yaml
metadata:
  annotations:
    apache-airflow/dags: my_dag_id
```

The value must match the `dag_id` field in Airflow exactly.

## Demo DAGs

Two example DAGs are mounted from the `dags/` directory in the repo:

| DAG ID | Schedule | Description |
|--------|----------|-------------|
| homelab_metrics_dag | Every hour | Collect & process homelab metrics |
| homelab_alerts_dag | Every 15 min | Check homelab alert conditions |

The `homelab-data-pipeline` Component in `examples/entities.yaml` is annotated
with `apache-airflow/dags: homelab_metrics_dag`.

## Known gaps

- The entity-tab wiring for the frontend plugin requires the new Backstage
  declarative integration alpha API.  This is tracked as a follow-up task.
- For production, consider using Airflow's token-based auth instead of basic
  auth.
