# OpenPanel product analytics

AIRI sends product events from the client to a self-hosted OpenPanel project. This setup covers product events and funnels. It does not migrate historical events, HogQL queries, or saved PostHog dashboards.

## Client configuration

Use `VITE_ENABLE_ANALYTICS` as the build switch for app analytics. User opt-out behavior remains active.

Client builds use the public API URL and write client id from `packages/stage-shared/src/analytics/openpanel.ts`. The stage apps share this configuration. CI variables and Docker build arguments do not carry these values.

Never put a client secret in a Vite variable. Allow only the intended application origins on the public OpenPanel client.

## Event behavior

Business event names stay unchanged. OpenPanel uses `screen_view` for automatic page views. Automatic outbound-link capture, attribute capture, and replay stay disabled.

The client keeps a device id in session storage. A reload in the same tab keeps this id. A consent change rotates it. Anonymous visitor counts therefore differ from a persistent browser identity.

Query strings and fragments are removed from automatic page URLs and referrers. This prevents authorization codes from entering those fields.

Per-generation analytics events are removed. Completed `message_round` events keep the model, the token usage, the duration, and the round identifiers.
`message_sent` keeps the provider selection. `message_round_failed` keeps the failure stage and the error code.
No client sends prompts or model responses to OpenPanel.

## Deployment

Run your own OpenPanel stack. Keep the database ports private. Keep the proxy on loopback until the domain and the TLS configuration are complete.

Before you release:

1. Confirm the public domain, the DNS record, and the HTTPS certificate.
2. Confirm the project and the public client.
3. Configure the allowed origins on the public client.
4. Send a marked browser event to the deployed API.
5. Confirm the event in OpenPanel.
6. Confirm the backup and restore procedure.
