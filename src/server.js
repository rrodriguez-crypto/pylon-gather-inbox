#!/usr/bin/env node
/**
 * pylon-gather-inbox
 * ------------------------------------------------------------------
 * Receives ticket-event webhooks from Pylon and mirrors them into a
 * Gather "Inbox" Smart Object: one activity entry per ticket currently
 * assigned to you, removed once that ticket's status moves to Customer
 * or Closed, plus a counter of how many are currently showing.
 *
 * Flow:
 *   Pylon Trigger ("Send webhook") --> this server --> Gather Inbox
 *
 * Pylon side (per https://docs.usepylon.com/pylon-docs/developer/webhooks):
 *   1. Settings > Webhooks > New destination
 *        URL:    https://<this-server-public-url>/pylon-webhook
 *      Copy the secret it shows you into PYLON_WEBHOOK_SECRET.
 *   2. Settings > Triggers > New trigger, Action = "Send webhook", pointed
 *      at the destination above. Create ONE trigger per event you want to
 *      forward, using this JSON body template (fill in real {{ }} variables
 *      from Pylon's own picker — start typing "{{" in the payload editor to
 *      see the exact field names available in your account):
 *
 *      Trigger "Assigned to me" (When: Issue Assigned, If: Assignee = you):
 *        {
 *          "event": "issue.assigned",
 *          "issue_id": "{{issue.id}}",
 *          "title": "{{issue.title}}",
 *          "url": "{{issue.link}}"
 *        }
 *
 *      Trigger "Resolved" (When: Issue Status Changed,
 *        If: Status = Customer OR Status = Closed, AND Assignee = you):
 *        {
 *          "event": "issue.resolved",
 *          "issue_id": "{{issue.id}}"
 *        }
 *
 *      The "Assignee = you" filter is what scopes this to only your
 *      tickets — this server does no filtering of its own, it just
 *      mirrors whatever Pylon sends it.
 *
 * Gather side:
 *   Decorate Desk > place the Inbox Smart Object > name it > click it >
 *   copy its Webhook URL + secret into GATHER_INBOX_URL / GATHER_INBOX_SECRET.
 *
 * Signature verification (Pylon):
 *   header `X-Pylon-Signature` = hex(HMAC_SHA256(secret, raw_request_body))
 *   per https://support.usepylon.com/articles/6080966819-how-do-i-verify-the-webhook-signatures
 *
 * @module
 */
import crypto from "node:crypto";
import "dotenv/config";
import express from "express";
import { createWebhookObjectClient, secretFromEnv } from "@gathertown/webhook-object-sdk";

const { GATHER_INBOX_URL, PYLON_WEBHOOK_SECRET, PORT = 3000 } = process.env;

if (!GATHER_INBOX_URL || !process.env.GATHER_INBOX_SECRET || !PYLON_WEBHOOK_SECRET) {
	console.error(
		"Missing required env vars. Copy .env.example to .env and fill in GATHER_INBOX_URL, GATHER_INBOX_SECRET, PYLON_WEBHOOK_SECRET.",
	);
	process.exit(1);
}

const inbox = createWebhookObjectClient({
	url: GATHER_INBOX_URL,
	secret: secretFromEnv("GATHER_INBOX_SECRET"),
});

/** Ids currently shown on the Inbox object (tickets assigned to you, not yet
 * moved to Customer/Closed), mirroring gather's own gh-prs-inbox example:
 * reconcile incrementally rather than clear-and-rewrite, so a single failed send
 * only desyncs one entry (self-healed on the next event) instead of the whole feed. */
const assignedTicketIds = new Set();

/** The receiver keeps a fixed-size ring buffer of activity entries; older ones are
 * evicted automatically, so we don't need to cap client-side beyond staying sane. */

async function addTicket({ issue_id, title, url }) {
	if (!issue_id) throw new Error("issue_id is required");
	await inbox.send("activity.add", {
		id: String(issue_id),
		text: title ? String(title) : `Ticket ${issue_id}`,
		...(url ? { url: String(url) } : {}),
	});
	assignedTicketIds.add(String(issue_id));
	await inbox.send("counter.set", { count: assignedTicketIds.size });
}

async function removeTicket({ issue_id }) {
	if (!issue_id) throw new Error("issue_id is required");
	await inbox.send("activity.remove", { id: String(issue_id) });
	assignedTicketIds.delete(String(issue_id));
	await inbox.send("counter.set", { count: assignedTicketIds.size });
}

const app = express();

// Signature verification needs the exact raw bytes Pylon signed, so capture them
// before express.json() parses (and potentially re-serializes) the body.
app.use(
	express.json({
		verify: (req, _res, buf) => {
			req.rawBody = buf;
		},
	}),
);

function verifyPylonSignature(req) {
	const signature = req.header("X-Pylon-Signature");
	if (!signature) return false;
	const expected = crypto
		.createHmac("sha256", PYLON_WEBHOOK_SECRET)
		.update(req.rawBody)
		.digest("hex");
	// Constant-time comparison to avoid leaking the secret via timing.
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/pylon-webhook", async (req, res) => {
	if (!verifyPylonSignature(req)) {
		console.error("Rejected webhook: bad or missing X-Pylon-Signature");
		return res.status(401).json({ error: "invalid signature" });
	}

	const { event, ticket_id, title, url } = req.body ?? {};

	try {
		switch (event) {
			case "assigned":
				await addTicket({ issue_id: ticket_id, title, url });
				break;
			case "resolved":
				await removeTicket({ issue_id: ticket_id });
				break;
			default:
				console.warn(`Unrecognized event "${event}", ignoring.`);
		}
		res.status(200).json({ ok: true });
	} catch (err) {
		console.error("Failed to relay event to Gather:", err instanceof Error ? err.message : err);
		res.status(200).json({ ok: false });
	}
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
	console.log(`pylon-gather-inbox listening on :${PORT}`);
	console.log(`Point Pylon's webhook destination at https://<your-public-host>/pylon-webhook`);
});
