# MyBiz Line — Call Center Town

An interactive 3D dashboard for the MyBiz Line phone business. The whole operation
rendered as a little town you can orbit, zoom, and click:

- **Town square** — today's pulse (calls answered, missed calls, voicemails waiting,
  unread texts). Click for the itemized lists.
- **Buildings** — one per line of business (Countertop HQ, Rentals, RE Deals).
  Height scales with today's volume; lit windows = active conversations right now.
- **Cars** driving the loop road — live calls in progress. Click for caller, duration, line.
- **Houses** on the outskirts — hot leads. A red flag means a callback is owed
  (unanswered 2+ hours).
- **Streetlights** — green when nothing is waiting, amber when something has waited
  2+ hours.

Zero build step: `index.html` + `styles.css` + `app.js`, Three.js r160 from CDN.
The page fetches `data.json` on load and re-polls every 30 seconds.

## Run it locally

Any static server works (plain `file://` will fail because `fetch` needs HTTP):

```bash
cd ~/workspace/mybiz-town
python3 -m http.server 8080
# open http://localhost:8080
```

## Data contract (`data.json`)

The page expects this exact shape. Every array may be empty; every scalar has a
sane fallback.

```json
{
  "generated_at": "2026-10-18T21:30:00-05:00",
  "source": "mock",
  "pulse": {
    "calls_answered_today": 14,
    "missed_calls_today": 3,
    "voicemails_waiting": 2,
    "unread_texts": 5
  },
  "live_calls": [
    {
      "id": "CA9f3a1b2c4d5e6f7a8b9c0d1",
      "caller_name": "Jamie Bruning",
      "caller_number": "+19135550142",
      "line": "Countertops",
      "started_at": "2026-10-18T21:24:10-05:00",
      "duration_sec": 352
    }
  ],
  "voicemails": [
    {
      "id": "RE5f1a2b3c4d5e6f7a8b9c0d1e",
      "caller_name": "Damon Greene",
      "caller_number": "+18165224253",
      "received_at": "2026-10-18T17:11:29-05:00",
      "duration_sec": 21,
      "transcript": "Hello, this is Damon Greene with Platinum Realty...",
      "listened": false
    }
  ],
  "texts": [
    {
      "id": "SM9e8f7a6b5c4d3e2f1a0b9c8d",
      "from_name": "Emmett Shaw",
      "from_number": "+19135550158",
      "listing": "Quartz",
      "body": "Just sent over the sink cutout specs.",
      "received_at": "2026-10-18T20:52:19-05:00",
      "read": false
    }
  ],
  "missed_calls": [
    {
      "id": "CA7c8d9e0f1a2b3c4d5e6f7a8b",
      "caller_name": "Dedan Jones",
      "caller_number": "+19135550176",
      "line": "Countertops",
      "received_at": "2026-10-18T18:05:12-05:00",
      "called_back": false
    }
  ],
  "buildings": [
    { "id": "countertops", "name": "Countertop HQ", "today_volume": 11, "active_conversations": 3 },
    { "id": "rentals",     "name": "Rentals",       "today_volume": 6,  "active_conversations": 1 },
    { "id": "redeals",     "name": "RE Deals",      "today_volume": 4,  "active_conversations": 2 }
  ],
  "leads": [
    {
      "id": "lead-001",
      "name": "Jamie Bruning",
      "listing": "Counter tops",
      "status": "new | contacted | quoted | callback_owed",
      "phone": "+19135550142",
      "last_activity_at": "2026-10-18T18:51:00-05:00",
      "unanswered_hours": 2.5,
      "note": "Confirmed 4-inch backsplash, waiting on rough measurements."
    }
  ]
}
```

Field notes:

- `status: "callback_owed"` is what raises the red flag on a house and turns the
  streetlights amber (along with any unlistened voicemail or unreturned missed call).
- Building height = `8 + today_volume * 1.4`, clamped to 8–30 units. Lit windows =
  first N windows where N = `active_conversations`.
- Timestamps are ISO 8601; the page renders them in the viewer's local timezone.
- `source: "mock"` shows a small "mock data" note in the legend; set it to anything
  else (e.g. `"live"`) to hide the note.

## Wiring real Twilio + Supabase (read this before going live)

**API keys must never ship in this frontend.** Anyone opening devtools can read
everything in `app.js`, so keep every secret server-side. Two supported patterns:

### Option A — n8n webhook (recommended, matches the existing stack)

1. Build an n8n workflow on a schedule (every 1–5 minutes) that:
   - Calls the Twilio REST API (`/Accounts/{SID}/Calls.json`,
     `/Messages.json`, `/Recordings.json`) filtered to today, and summarizes into
     `pulse`, `live_calls` (`status=in-progress`), `voicemails`
     (recordings with a transcript), `texts`, and `missed_calls`.
   - Queries Supabase (Postgres node) for the leads table → `leads`, and whatever
     drives `buildings` (e.g. counts by line of business).
   - Responds to a Webhook node with the JSON above.
2. The static site can't call n8n directly from the browser without exposing
   credentials — instead have n8n **write the JSON to `data.json`** on deploy
   (n8n → GitHub node committing to the repo, or n8n → Vercel Blob / S3 that the
   page fetches). The page keeps polling the file; n8n keeps rewriting it.

### Option B — tiny backend endpoint

A ~40-line endpoint (Node/Express, Python/FastAPI, or a Vercel serverless
function) that holds `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
`SUPABASE_SERVICE_KEY` in environment variables, assembles the JSON above, and
serves it at `/api/town-data`. Point the page at that URL by changing
`DATA_URL` in `app.js`. This keeps every secret server-side and gives you
sub-minute freshness.

Twilio call mapping cheat-sheet:

| Town element | Twilio source |
|---|---|
| Live-call cars | `Calls` with `status=in-progress` (caller `from_formatted`, `duration`) |
| Missed calls | `Calls` with `status=no-answer`/`busy`/`failed` today |
| Voicemails | `Recordings` on the voicemail number + transcriptions |
| Unread texts | `Messages` `direction=inbound` not yet marked read in your DB |
| Calls answered | `Calls` `status=completed` with today's `start_time` |

Supabase mapping: one `leads` table (or view) with
`name, listing, status, phone, last_activity_at, unanswered_hours, note`.
`status = 'callback_owed'` should be computed (e.g. a view: last inbound activity
older than 2h with no outbound reply since).

## Deploy

It's static — anything works:

- **Vercel:** `vercel` in this directory, or drag-drop the folder in the dashboard,
  or push to GitHub and import the repo. No build command, no output directory
  changes needed.
- **GitHub → Cursor:** push this folder as a repo; open in Cursor and iterate on
  `app.js` directly. To preview: `python3 -m http.server` or the Cursor/VS Code
  Live Server extension.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell, HUD, legend, stats-card overlay |
| `styles.css` | All UI styling |
| `app.js` | Three.js town: scene, animation, raycast clicks, polling |
| `data.json` | Data contract + mock dataset (replace with the live feed) |
| `README.md` | This file |
