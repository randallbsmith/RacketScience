# RacketScience

## Live page (GitHub Pages + Google Sheet)

`index.html` is the published page at https://randallbsmith.github.io/RacketScience/. It reads and writes the Google Sheet through the Apps Script web app in `apps-script/Code.gs` (deployed with *Execute as: Me*, *Who has access: Anyone*). The sheet remains the data store, and its existing reminder/reset scripts keep running. The Node server described below is an alternative that is not in use.


A small tennis roster: one HTML page, a Node.js server, and one JSON state file. No database and no external JavaScript dependencies.

## Status

Implemented: Google OAuth sign-in with an email allowlist, individual field updates, atomic file replacement and a cross-process file lock, game-date conflict protection, reset and reminder scripts, a disabled-by-default Pacific-time scheduler, and automated tests.

Not deployed. Google credentials, the approved account list, a verified email sender, and a persistent server must be configured. No email has been sent. No schedule is enabled. GitHub holds source; GitHub Pages cannot run this server.

## Run

Use Node.js 22 or later. No npm installation is necessary.

1. Copy `.env.example` to `.env`, `allowed-users.example.json` to `allowed-users.json`, and `state.example.json` to `data/state.json` (create `data/` first). Never overwrite an existing live state file.
2. Set a randomly generated `SESSION_SECRET` as described in `.env.example`.
3. Create a Google OAuth **Web application** client. For local use, add `http://localhost:3000/auth/callback` as its authorized redirect URI. Set its client ID and secret in `.env`. Only `openid email` scopes are requested. For deployment, register the corresponding HTTPS callback URL. Google's testing-mode user restrictions may also require adding the approved accounts as test users until the OAuth app is published.
4. Put approved Google account email addresses into `allowed-users.json`. These are independent of editable contact addresses. All approved members can edit all roster fields, like the shared sheet. No account bypass is provided.
5. Set `state.json`'s `gameDate` to the current game in `YYYY-MM-DD` form and fill in the roster. The sample is fictional. The existing real roster is retained only in the local ignored `data/state.json`.
6. Run `npm start` and visit `http://localhost:3000`. Sign in with an approved Google account.

`npm test` uses isolated temporary files and a mock mail sender. It never sends email or modifies the real roster.

## Shared state and concurrency

Browsers load `/api/state` and PATCH `/api/field` with `{gameDate, playerId, field, previous, value}`. Team notes omit `playerId`. Radio choices save immediately; text saves after 700 ms of inactivity or on blur. Controls send only their individual field. Successful writes survive server restarts.

Every patch re-reads the latest file under a shared lock and compares the previous field value. Independent edits merge. A same-field conflict or old game date returns HTTP 409. The browser keeps unsaved text visible and asks the player to reload to review; it does not silently overwrite it. Idle pages refresh every 15 seconds.

Files are written to a temporary file, flushed, and renamed over `state.json`. Atomic directory creation provides a lock shared by the API and job scripts on the same local filesystem. A crashed process may leave `data/state.lock`; stop all writers and confirm the lock is orphaned before removing that empty directory. The server intentionally never steals a lock from a potentially active writer. Keep backups of `data/` outside the repository.

## The two jobs (Pacific time, including daylight saving)

- **Monday and Thursday, 1 AM:** send a reminder and the app URL to each unique current primary email address. Alternates, blank/invalid addresses, and addresses ending in `unknown.com` are excluded. Each recipient gets a separate email.
- **Tuesday and Friday, 3 PM:** reset attendance to `null`, clear player comments, and advance `gameDate` to the next strictly future Tuesday or Friday. Names, contact information and team notes remain intact. The displayed game date stays unchanged until reset.

Use `npm run reminders` for a dry run. It prints eligible addresses locally without sending. Email transport uses Resend's HTTPS API: configure `RESEND_API_KEY`, a verified `EMAIL_FROM`, and the HTTPS `APP_URL`. Sending requires the explicit command `npm run reminders -- --send`; it only sends on reminder days after 1 AM. Delivery receipts and provider idempotency keys reduce duplicates on retries. Provider acceptance does not guarantee inbox delivery; check the provider's delivery/bounce dashboard. After a rare uncertain delivery older than the provider's idempotency retention, inspect delivery history before manually retrying.

`npm run reset` safely does nothing outside Tuesday/Friday after 3 PM or if that day's reset has already happened.

When ready to activate, set `SCHEDULES_ENABLED=true` and run `npm run scheduler` as a supervised process alongside the web server. It checks every minute, with both scripts using the same `DATA_DIR`. It retries failures and catches up after a restart later on the scheduled day. A full missed day requires organizer attention; it does not silently discard a previous game's data on another day. Leave it disabled while developing. Do not also enable a second external scheduler.

## Hosting

Run a single application instance on a server with persistent local disk. Place it behind an HTTPS reverse proxy, set `APP_URL` to the exact public origin, and keep the Node port private (default `127.0.0.1`). Run the server and optional scheduler under a process supervisor with a restart policy, using this directory as their working directory. Back up the state file and protect the disk; HTTPS alone does not secure a public storage folder.

Only the page and two explicitly named images are served. State is returned only after Google authentication and allowlist checking; secrets, raw data files, delivery receipts, and the allowlist are never static routes. Updates require same-origin requests and a session CSRF token. Sessions expire after 14 days; removing an email from the allowlist revokes access on the next request. Restarting the server cancels pending sign-ins, but valid sessions remain usable with the same secret. Rotating the secret invalidates all sessions.

Keep `.env`, `allowed-users.json`, and `data/` out of GitHub. The included `.gitignore` excludes them even if the repository later becomes public. The original standalone local prototype remains outside this project.

## Files

- `tennis.html`, `racket-left.png`, `racket-right.png`: browser UI and title images
- `server.js`: authenticated HTTP server and Google sign-in
- `store.js`: locked JSON storage and field validation
- `dates.js`: Pacific calendar helpers
- `reset-game.js`, `send-reminders.js`, `scheduler.js`: jobs and scheduling
- `state.example.json`, `allowed-users.example.json`, `.env.example`: configuration templates
- `app.test.js`: concurrency, reset, date, recipient and access-boundary checks
- `package.json`, `package-lock.json`: commands and Node requirement (no dependencies)

Reference: [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Resend email API](https://resend.com/docs/api-reference/emails/send-email).
