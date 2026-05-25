# Google Calendar setup

Glance shows your upcoming Google Calendar events in the CALENDAR column.
Google requires per-app OAuth, so each user creates their own OAuth client
in their own Google Cloud project. Nothing private is stored in this repo;
the token lives in `~/.config/glance/google-token.json` (mode 600).

## 1. Create an OAuth client in Google Cloud

One-time setup, about 5 minutes.

1. Open <https://console.cloud.google.com> and create (or select) a project.
2. APIs & Services -> Library -> search "Google Calendar API" -> Enable.
3. APIs & Services -> OAuth consent screen:
   - User Type: External.
   - App name: anything (`glance` is fine).
   - User support email: yours.
   - Developer contact: yours.
   - Scopes step: skip; the script requests `calendar.readonly` at runtime.
   - Test users: add your own Google account.
4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID:
   - Application type: **Desktop app**.
   - Name: `glance`.
   - Click Create.
5. Copy the **Client ID** and **Client Secret** from the resulting dialog.

The app stays in "Testing" mode. That is fine for personal use. Google's
test mode only allows up to 100 explicitly-listed test users, which is
all you need for a personal dashboard. No verification is required.

## 2. Run the auth helper

From the repo root:

```
node server/bin/google-auth.js --calendar
```

(`gcal-auth.js` still works as a deprecated alias for `google-auth.js --calendar`.
If you want Gmail support too, see [GMAIL-SETUP.md](GMAIL-SETUP.md) and pass
`--gmail` or no flags at all to get both scopes.)

- Paste the `client_id` and `client_secret` when prompted.
- A browser tab opens; sign in to your Google account and grant the
  calendar read scope.
- The tab shows "Authorized" once done. Return to the terminal.
- Token is written to `~/.config/glance/google-token.json`.

## 3. Wire it up

Add to `~/.config/glance/config.json`:

```json
{
  "calendarBin": "/absolute/path/to/glance/server/bin/gcal.js"
}
```

The auth helper prints the absolute path at the end; copy it from there.

Restart the glance backend (disable then enable the extension, or kill
the `node server/server.js` process). The CALENDAR column should
populate within a refresh cycle (about 60 seconds).

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
