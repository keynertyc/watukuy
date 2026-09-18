# webhook-sink

"Webhooks for APIs that don't have them", literally. watukuy polls a third-party API that has
no webhooks and re-emits every change as an outgoing webhook signed per the
[Standard Webhooks](https://www.standardwebhooks.com) spec. A plain `node:http` receiver, the
kind you would write in your own app, verifies the signature with `verifyWebhookSignature()`
from `watukuy/sinks` and prints the CloudEvent.

Both processes live in `main.ts` for convenience; they only talk over HTTP on `127.0.0.1`.

## Run

```sh
pnpm install && pnpm build          # once, at the repo root
pnpm --dir examples/webhook-sink start
# or: node examples/webhook-sink/main.ts --duration 20
```

Runs until Ctrl+C unless `--duration <seconds>` is given.

## What it shows

- `engine.on('orders', webhookSink({ url, secret }))`: the handler *is* the webhook.
- Headers `webhook-id` (= `event.id`), `webhook-timestamp`, `webhook-signature`
  (`v1,<base64 HMAC-SHA256>` over `${id}.${timestamp}.${body}`); body is
  `toCloudEvent(event)` (`type` = `orders.created` / `orders.updated`).
- The receiver deliberately answers `503` to the 4th delivery. The sink throws a
  `WebhookDeliveryError`; the dispatcher (not the sink) retries with backoff and the retry
  carries the **same** `webhook-id`, so an idempotent receiver can dedupe. The `onRetry` hook
  prints the scheduled delay.
- A request with a bad signature is rejected with 401 before the body is even parsed.

## What you will see

```
[receiver] listening at http://127.0.0.1:55474/hooks/orders
[engine]   polling FakeApi; every change becomes a signed POST
[receiver] orders.created ord-1 seq=1 open $100
[receiver] orders.created ord-2 seq=2 open $200
[receiver] orders.created ord-3 seq=3 open $300
[receiver] ce5bb04c2d98 -> 503 (simulated outage; watch it come back)
[engine]   retry #1 for ord-3 in 421ms
[receiver] orders.updated ord-3 seq=4 paid $300
[receiver] orders.updated ord-2 seq=5 paid $200
[receiver] orders.updated ord-1 seq=6 paid $100
[receiver] orders.updated ord-1 seq=7 shipped $100
[receiver] orders.updated ord-3 seq=8 shipped $300
[receiver] orders.updated ord-2 seq=9 shipped $200
[receiver] orders.created ord-4 seq=10 open $485
[receiver] orders.created ord-5 seq=11 open $413
[receiver] orders.updated ord-4 seq=12 paid $485
[engine]   20s elapsed: stopping
[engine]   done. delivered=12 pending=0 parked=0
```

`ce5bb04c2d98` is the first 12 hex chars of the deterministic event id; the redelivered event
(`ord-3 seq=4`) arrives about half a second later (full-jitter backoff on a 1s base).

## Things to try

- Change `SECRET` on one side only: every delivery is rejected with 401, retried 5 times, then
  parked (`onParked` prints it; `engine.parked.list('orders')` lists it).
- Point `url` at a request bin or your own service; add `headers: { authorization: ... }` for
  receivers that also want a bearer token.
- Set `format: 'raw'` on the sink to POST the `WatukuyEvent` envelope instead of a CloudEvent.
