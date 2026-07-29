[README.md](https://github.com/user-attachments/files/30519533/README.md)
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

**Trigger: "Ticket assigned to me → Gather Inbox"**
_When: Issue assigned — to [you]_

```json
{
  "event": "assigned",
  "ticket_id": "{{ issue.id }}",
  "title": "{{ issue.title }}",
  "status": "{{ issue.status }}",
  "url": "{{ issue.link }}"
}
```

The `to [you]` condition on the trigger itself is what scopes this to your
own tickets — no separate assignee check is needed server-side, since this
endpoint is simply never called for tickets assigned to someone else.

**Trigger: "Ticket closed → Gather Inbox"**
_When: Issue status changed — If: Status is Closed_

```json
{
  "event": "closed",
  "ticket_id": "{{ issue.id }}"
}
```

This one has no assignee filter — it fires for any closed ticket, and the
server just does nothing if that ticket was never added (i.e. it wasn't
yours to begin with).

## How it works

- Each incoming request is verified against `X-Pylon-Signature`
  (`hex(HMAC_SHA256(PYLON_WEBHOOK_SECRET, raw_body))`); anything that doesn't
  match is rejected with `401` before it's parsed.
- `"event": "assigned"` → `activity.add` (one paper per ticket, tracked by
  `ticket_id`) then `counter.set` to the current open-ticket count. This is
  what makes the papers pile up in the Inbox as tickets get assigned to you —
  each `ticket_id` is its own entry, so nothing gets overwritten or merged.
- `"event": "closed"` → `activity.remove` for that specific ticket's
  `ticket_id` only, then `counter.set` again. Every *other* paper in the pile
  is untouched — only the paper matching the resolved ticket's ID disappears.
- Ticket state is tracked in memory (a `Set` of open ids) and reconciled
  incrementally rather than clearing/rewriting the whole feed each time, so a
  single failed delivery only desyncs one entry rather than emptying the
  board. If you restart the server, the Inbox will keep whatever it last
  showed until the next `assigned`/`closed` event corrects it — for a
  from-scratch resync on boot, add a startup step that calls Pylon's
  `/issues/search` API for your open, assigned tickets and calls
  `activity.add` for each.

## Notes

- Anyone in the space can see the Inbox's activity feed — don't put anything
  sensitive (e.g. customer PII) in `title`; a short ticket subject or number
  is safer than the full issue body.
- Rate limits are space-wide across all Smart Objects, so if you have a busy
  queue, consider batching (e.g. `counter.set` more often than
  `activity.add`/`remove`).
