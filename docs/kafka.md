# Kafka Integration

## Overview

The Kafka integration uses
[`@backstage-community/plugin-kafka-backend`](https://github.com/backstage/community-plugins/tree/main/workspaces/kafka)
to expose Kafka cluster topic and consumer-group lag information through the
Backstage API.  On the frontend, entity pages for annotated components show a
**Kafka** tab with topic/consumer details.

## Configuration

### app-config.yaml

```yaml
kafka:
  clientId: homelab-backstage   # Kafka producer client ID
  clusters:
    - name: local               # Logical name shown in the UI
      dashboardUrl: http://localhost:9000   # Optional link to Kafka UI
      brokers:
        - ${KAFKA_BROKERS}      # e.g. kafka:9092
```

`KAFKA_BROKERS` accepts a comma-separated list of `host:port` pairs.

### Backend registration

The plugin is registered in `packages/backend/src/index.ts`:

```ts
backend.add(import('@backstage-community/plugin-kafka-backend'));
```

## Entity annotations

Add the following annotation to a `Component` entity to link it to a Kafka
consumer group:

```yaml
metadata:
  annotations:
    kafka.apache.org/consumer-groups: my-consumer-group
```

Multiple groups can be listed as a comma-separated string.

## Demo topics

Three topics are created by the `kafka-init` Docker Compose service:

| Topic | Partitions |
|-------|-----------|
| homelab-events | 3 |
| homelab-metrics | 3 |
| homelab-alerts | 1 |

The `homelab-event-producer` Component in `examples/entities.yaml` is
annotated to show consumer group data for `homelab-events-consumers`.

## Known gaps

- The frontend card (`@backstage-community/plugin-kafka`) needs wiring via the
  new Backstage declarative integration alpha API to appear on entity pages.
  This is tracked as a follow-up task.
