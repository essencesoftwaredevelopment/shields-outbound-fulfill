# Essence AI Demo — Calendly public API

Public endpoints on the shields-outbound server for the **essence-retention** client.
No auth header. Default event type is **ESSENCE AI Demo**
(`30336f6d-1955-4c5f-ad3c-49f319bd61e3`).

Local host: `http://localhost:4000`

---

## 1. Available times

```
GET /api/clients/essence-retention/calendly/available-times
```

No body. Query params only.

```http
GET /api/clients/essence-retention/calendly/available-times?startTime=2026-09-01T00:00:00Z&endTime=2026-09-08T00:00:00Z
```

```bash
curl -G 'http://localhost:4000/api/clients/essence-retention/calendly/available-times' \
  --data-urlencode 'startTime=2026-09-01T00:00:00Z' \
  --data-urlencode 'endTime=2026-09-08T00:00:00Z'
```

| Query | Required | Notes |
|---|---|---|
| `startTime` | no | ISO 8601 UTC. Defaults to now. `start_time` also accepted. |
| `endTime` | no | ISO 8601 UTC. Defaults to start + 7 days. Window cannot exceed 7 days. `end_time` also accepted. |
| `eventType` | no | UUID or full Calendly URI. Defaults to Essence AI Demo. `event_type` also accepted. |

### Response `200`

```json
{
  "eventType": "https://api.calendly.com/event_types/30336f6d-1955-4c5f-ad3c-49f319bd61e3",
  "startTime": "2026-09-01T00:00:00.000Z",
  "endTime": "2026-09-08T00:00:00.000Z",
  "times": [
    {
      "startTime": "2026-09-02T14:00:00.000000Z",
      "status": "available",
      "inviteesRemaining": 1,
      "schedulingUrl": "https://calendly.com/essencesoftwaredevelopment/essence-ai-demo/2026-09-02T14:00:00Z"
    }
  ]
}
```

Use a `times[].startTime` as `startTime` on the book call.

---

## 2. Book

```
POST /api/clients/essence-retention/calendly/book
Content-Type: application/json
```

### Body

```json
{
  "startTime": "2026-09-02T14:00:00.000Z",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "timezone": "America/New_York",
  "questionsAndAnswers": [
    { "question": "Phone", "answer": "+1 416-877-5536" },
    { "question": "Website", "answer": "https://analytical.engine" },
    { "question": "How big is the email list within your Klaviyo/Email Sending Provider", "answer": "1,000 - 2,000" },
    { "question": "Current D2C Revenue Per Month (USD, Approximate)", "answer": "$10k to $20k" },
    { "question": "What percentage of revenue is coming from Klaviyo/Email Sending Provider?", "answer": "15%" }
  ]
}
```

```bash
curl -X POST 'http://localhost:4000/api/clients/essence-retention/calendly/book' \
  -H 'Content-Type: application/json' \
  -d '{
    "startTime": "2026-09-02T14:00:00.000Z",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "timezone": "America/New_York",
    "questionsAndAnswers": [
      { "question": "Phone", "answer": "+1 416-877-5536" },
      { "question": "Website", "answer": "https://analytical.engine" },
      { "question": "How big is the email list within your Klaviyo/Email Sending Provider", "answer": "1,000 - 2,000" },
      { "question": "Current D2C Revenue Per Month (USD, Approximate)", "answer": "$10k to $20k" },
      { "question": "What percentage of revenue is coming from Klaviyo/Email Sending Provider?", "answer": "15%" }
    ]
  }'
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `startTime` | **yes** | UTC slot from available-times. `start_time` also accepted. |
| `name` | **yes** | Full name. Or `firstName` + `lastName`, or nested `invitee.name`. |
| `email` | **yes** | |
| `timezone` | no | IANA tz. Defaults to `America/New_York`. |
| `eventType` | no | Defaults to Essence AI Demo. |
| `questionsAndAnswers` | **yes** (for this event) | Array of `{ question, answer }`. Also accepts `questions_and_answers`, `answers`, or a keyed object (`{ "Website": "…" }`). Questions match by name (case-insensitive), `questionUuid`, or `position`. |

Nested invitee shape also works:

```json
{
  "startTime": "2026-09-02T14:00:00.000Z",
  "invitee": {
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "timezone": "America/New_York"
  },
  "questionsAndAnswers": []
}
```

### Custom questions (ESSENCE AI Demo)

All five are present on every stored booking — send all of them.

| # | Question | Answer type | Example |
|---|---|---|---|
| 0 | Phone | phone | `+1 416-877-5536` |
| 1 | Website | text | `https://analytical.engine` |
| 2 | How big is the email list within your Klaviyo/Email Sending Provider | select / text | `1,000 - 2,000` |
| 3 | Current D2C Revenue Per Month (USD, Approximate) | select | `$10k to $20k` |
| 4 | What percentage of revenue is coming from Klaviyo/Email Sending Provider? | text | `15%` |

Known revenue choices: `$0 to $3k`, `$0 to $10k`, `$10k to $20k`, `$20k to $50k`, `$50k to $130k`, `$400k to $800k`.

Known list-size choices include: `1,000 - 2,000`, `2,000- 4,000`, `4,000 - 8,000`, `8,000 - 15,000`, `15,000 - 30,000`, `30,000 - 50,000`. Match a choice when you can.

### Response `201`

```json
{
  "uri": "https://api.calendly.com/scheduled_events/EVT/invitees/INV",
  "event": "https://api.calendly.com/scheduled_events/EVT",
  "eventType": "https://api.calendly.com/event_types/30336f6d-1955-4c5f-ad3c-49f319bd61e3",
  "startTime": "2026-09-02T14:00:00.000Z",
  "status": "active",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "timezone": "America/New_York",
  "cancelUrl": "https://calendly.com/cancellations/INV",
  "rescheduleUrl": "https://calendly.com/reschedulings/INV",
  "questionsAndAnswers": [
    { "question": "Phone", "answer": "+1 416-877-5536", "position": 0 }
  ]
}
```

A successful book also fires the existing Calendly `invitee.created` webhook (timeline + Discovery Pre Call email).

---

## Errors

| Status | When |
|---|---|
| `400` | Missing/invalid fields, required question unanswered, slot not available |
| `403` | `:clientId` is not essence-retention |
| `404` | Client not found |
| `502` | Calendly rejected the PAT or upstream call failed |
| `503` | `CALENDLY_API_KEY` / `CALENDLY_PAT` not configured |
