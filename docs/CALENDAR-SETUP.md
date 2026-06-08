# Google Calendar setup

Glance shows your upcoming Google Calendar events in the CALENDAR column.
The token lives in `~/.config/glance/google-token.json` (mode 600). Nothing
private is stored in this repo.

Glance uses your own OAuth client. Google has stopped letting third-party
tools borrow shared or default client IDs (including the gcloud CLI's) for
Calendar and Gmail scopes, so bring-your-own-client is the only durable path.
The client is created once per project; after that, each machine just drops
the client file in place and runs the helper, with no secret to paste.

For Klarum, the client already exists: `klarum-dev` in `klarum-internal-tools`.
Download its JSON from the Console (APIs & Services -> Credentials -> klarum-dev
-> Download) and skip to section 2. Anyone standing this up in a fresh project
follows section 1.

## 1. Create an OAuth client (once per project)

One-time setup, about 5 minutes.

1. Open <https://console.cloud.google.com> and select the project.
2. APIs & Services -> Library -> search "Google Calendar API" -> Enable.
   (The helper also tries to enable this for you via gcloud; doing it here is
   the fallback if you lack the gcloud rights.)
3. APIs & Services -> OAuth consent screen:
   - User Type: Internal (Workspace org) or External.
   - App name: `glance`. User support + developer contact: yours.
   - Scopes step: skip; the helper requests `calendar.readonly` at runtime.
   - Test users (External only): add the Google accounts that will connect.
4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID:
   - Application type: **Desktop app** is simplest. A **Web application** client
     (like klarum-dev) also works, as long as it has an `http://localhost`
     redirect URI (any port/path) under Authorized redirect URIs: the helper
     reuses that exact URI for its loopback callback. Make sure that port is
     free while you run the helper.
   - Name: `glance`. Click Create.
5. In the resulting dialog, click **Download JSON**. This is the
   `client_secret_*.json` file the helper auto-loads.

## 2. Put the client file where the helper looks for it

Copy the downloaded JSON to either location on each machine that connects:

```
cp ~/Downloads/client_secret_*.json ~/.config/glance/google-client.json
```

or point an env var at it: `export GLANCE_GOOGLE_CLIENT_FILE=/path/to/client_secret.json`.

Keep this file out of the repo and treat it as a secret (a Web client's secret
is confidential; a Desktop client's is less so). It is the one artifact an admin
distributes to the team, mode 600 alongside the token.

## 3. Run the auth helper

From the repo root:

```
node server/bin/google-auth.js --calendar
```

(`gcal-auth.js` still works as a deprecated alias for `google-auth.js --calendar`.
For Gmail too, see [GMAIL-SETUP.md](GMAIL-SETUP.md) and pass `--gmail`, or no
flags at all, to get both scopes.)

- The helper loads the client from the file above (no pasting). If no file is
  found, it reuses the client in an existing token, then falls back to a prompt.
- A browser tab opens; sign in and grant the calendar read scope.
- The tab shows "Authorized" once done. Return to the terminal.
- The token is written to `~/.config/glance/google-token.json`, and
  `calendarBin` is wired into `~/.config/glance/config.json` automatically.

Restart the glance backend and the CALENDAR column populates within a refresh
cycle (about 60 seconds). The wiring step means you do not normally edit
`config.json` by hand; the manual key is below for reference.

## config.json reference

```json
{
  "calendarBin": "/absolute/path/to/glance/server/bin/gcal.js"
}
```

The helper writes this for you; set it by hand only if you skipped the helper.

## Manual sanity check

```
node server/bin/gcal.js list 7
```

Each line is one event, in the format:

```
2026-05-23T10:00:00+02:00 Team standup [abc123event-id]
```

All-day events emit a date instead of a full timestamp:

```
2026-05-25 Conference [xyz789all-day-id]
```

## Re-auth

Delete `~/.config/glance/google-token.json` and rerun `gcal-auth.js`.

## Troubleshooting

- **"No refresh_token returned"**: Google only issues a refresh token on
  the first consent for a given client. Revoke at
  <https://myaccount.google.com/permissions> (find the entry for your
  client, click Remove) and rerun the auth script.
- **"invalid_client"**: client_id or client_secret pasted with a typo.
  Recopy from the Cloud Console.
- **"redirect_uri_mismatch"**: the script uses `http://127.0.0.1:8765`.
  Desktop OAuth clients allow any localhost URI by default. If you see
  this, the OAuth client was created as a Web application type by
  mistake. Recreate as Desktop app.
- **"Access blocked: ... has not completed the Google verification process"**:
  add your Google account as a test user under OAuth consent screen ->
  Audience -> Test users.
- **Port 8765 already in use**: kill whatever is bound to it, or edit
  `REDIRECT_PORT` in `server/bin/gcal-auth.js` and rerun.

## Why BYO credentials

Glance is a public repo, so shipping a shared OAuth client would mean
every user shares one quota, anyone could extract the client_secret, and
the verification status of the shared app would gate all users. With
per-user OAuth clients, your token is yours, your quota is yours, and
the repo carries no secrets.
