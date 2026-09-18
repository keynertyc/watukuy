/**
 * `watukuy/otel` — OpenTelemetry spans and metrics for watukuy (see docs/observability.md).
 *
 * Requires the optional peer `@opentelemetry/api`. Without a registered SDK the API no-ops, so the
 * hooks are safe to ship in every environment.
 *
 * @example
 * ```ts
 * import { createWatukuy } from 'watukuy';
 * import { otelHooks } from 'watukuy/otel';
 *
 * const engine = createWatukuy({ pollers: { orders }, hooks: [otelHooks()] });
 * ```
 *
 * @packageDocumentation
 */

export { type OtelHooksOptions, otelHooks } from './hooks.ts';
