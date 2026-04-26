# lastanime-telegram

JavaScript bot that checks `movies`, `series`, and `episodes` tables every 10 minutes and sends Telegram alerts when rows are updated.

It saves only the latest sent notification payload in `state/sent-notifications.json` so older batches are automatically replaced.

Episode dedupe tracking uses a strict key format: `series_slug|Sxx|Exx`.
This ensures same series ke new episodes (for example S01E02 after S01E01) always get sent.

For Render or similar platforms, app now listens on `PORT` (default `3000`).
Health endpoint: `/health`

## Setup

1. Add required values in `.env`:
	- `SUPABASE_URL`
	- `SUPABASE_ANON_KEY`
	- `TELEGRAM_BOT_TOKEN`
	- `CHANNEL_ID` (or `CHHANEL_ID`)
2. Install dependencies:

	npm install

3. Start service:

	npm start