# pylon-gather-inbox

Relays Pylon support-ticket events into a Gather **Inbox** Smart Object, so
papers stack up in your virtual office as tickets come in, and the counter
tracks how many are currently open.

```
Pylon (Trigger → Send webhook)  --HTTPS-->  this server  --HTTPS-->  Gather Inbox object
```

## 1. Place the Inbox Smart Object in Gather

1. Main Menu → **Decorate Desk** → search **Smart Objects** → place the **Inbox**.
2. Name it, then close the Decorator and click the object → its **⋮** menu.
3. Copy the **Webhook URL** and **secret** (`whsec_...`) into `.env` as
   `GATHER_INBOX_URL` / `GATHER_INBOX_SECRET`.

## 2. Deploy this server somewhere reachable over HTTPS

```sh
cp .env.example .env   # fill in the values described below
npm install
npm start
```

It listens on `POST /pylon-webhook` (health check at `GET /healthz`). Put it
behind whatever gives you a public HTTPS URL (a reverse proxy, a tunnel like
ngrok for testing, or your usual hosting/deploy pipeline).

## 3. Configure Pylon

**Webhook destination** — Pylon Settings → **Webhooks** → new destination:

- URL: `https://<your-public-host>/pylon-webhook`
- Copy the **secret** shown when you create it into `.env` as `PYLON_WEBHOOK_SECRET`.

**Triggers** — Pylon Settings → **Triggers** → new trigger, Action = **Send
webhook**, targeting the destination above. Create one trigger per event.
Pylon lets you build the JSON body with `{{ }}` template variables — start
typing `{{` in the payload editor to see the exact field names available in
your account (the ones below are typical, but confirm against your account's
picker).

**Trigger: "New ticket → Gather Inbox"**
_When: Issue Created_

```json
{
  "event": "issue.created",
  "issue_id": "{{issue.id}}",
  "title": "{{issue.title}}",
  "url": "{{issue.link}}"
}
```

**Trigger: "Ticket closed → Gather Inbox"**
_When: Issue Status Changed — If: Status is Closed_

```json
{
  "event": "issue.closed",
  "issue_id": "{{issue.id}}"
}
```

## How it works

- Each incoming request is verified against `X-Pylon-Signature`
  (`hex(HMAC_SHA256(PYLON_WEBHOOK_SECRET, raw_body))`); anything that doesn't
  match is rejected with `401` before it's parsed.
- `issue.created` → `activity.add` (one entry per ticket, tracked by
  `issue_id`) then `counter.set` to the current open-ticket count.
- `issue.closed` → `activity.remove` for that ticket, then `counter.set` again.
- Ticket state is tracked in memory (a `Set` of open ids) and reconciled
  incrementally rather than clearing/rewriting the whole feed each time, so a
  single failed delivery only desyncs one entry rather than emptying the
  board. If you restart the server, the Inbox will keep whatever it last
  showed until the next `created`/`closed` event corrects it — for a
  from-scratch resync on boot, add a startup step that calls Pylon's
  `/issues/search` API for open tickets and calls `activity.add` for each.

## Notes

- Anyone in the space can see the Inbox's activity feed — don't put anything
  sensitive (e.g. customer PII) in `title`; a short ticket subject or number
  is safer than the full issue body.
- Rate limits are space-wide across all Smart Objects, so if you have a busy
  queue, consider batching (e.g. `counter.set` more often than
  `activity.add`/`remove`).
