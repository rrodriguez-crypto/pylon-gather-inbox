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
- Optionally set `PYLON_ASSIGNEE_ID` in `.env` to your own Pylon user id — this
  is a server-side double-check that a ticket is really assigned to you before
  it gets piled into the Inbox, on top of the trigger condition below.

**Triggers** — Pylon Settings → **Triggers** → new trigger, Action = **Send
webhook**, targeting the destination above. Create one trigger per event.
Pylon lets you build the JSON body with `{{ }}` template variables — start
typing `{{` in the payload editor to see the exact field names available in
your account (the ones below are typical, but confirm against your account's
picker).

**Trigger: "Ticket assigned to me → Gather Inbox"**
_When: Issue Assigned — If: Assignee is you_

```json
{
  "event": "issue.assigned",
  "issue_id": "{{issue.id}}",
  "title": "{{issue.title}}",
  "url": "{{issue.link}}",
  "assignee_id": "{{issue.assignee.id}}"
}
```

The `If: Assignee is you` condition is what actually scopes this to your own
tickets — the webhook simply never fires for tickets assigned to someone
else. `assignee_id` is still sent so the server can double-check (see
`PYLON_ASSIGNEE_ID` below) in case that condition is ever loosened.

**Trigger: "Ticket closed → Gather Inbox"**
_When: Issue Status Changed — If: Status is Closed_

```json
{
  "event": "issue.closed",
  "issue_id": "{{issue.id}}"
}
```

This one intentionally has no assignee filter — it fires for any closed
ticket, and the server just does nothing if that ticket was never added
(i.e. it wasn't yours to begin with).

## How it works

- Each incoming request is verified against `X-Pylon-Signature`
  (`hex(HMAC_SHA256(PYLON_WEBHOOK_SECRET, raw_body))`); anything that doesn't
  match is rejected with `401` before it's parsed.
- `issue.assigned` → if `PYLON_ASSIGNEE_ID` is set and the incoming
  `assignee_id` doesn't match it, the event is ignored (belt-and-suspenders on
  top of Pylon's own trigger condition). Otherwise: `activity.add` (one paper
  per ticket, tracked by `issue_id`) then `counter.set` to the current
  open-ticket count. This is what makes the papers pile up in the Inbox as
  tickets get assigned to you — each `issue_id` is its own entry, so nothing
  gets overwritten or merged.
- `issue.closed` → `activity.remove` for that specific ticket's `issue_id`
  only, then `counter.set` again. Every *other* paper in the pile is
  untouched — only the paper matching the resolved ticket's ID disappears.
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
