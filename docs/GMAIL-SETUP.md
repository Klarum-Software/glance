# Gmail setup

Glance can show your unread Gmail in the INBOX column and let you read,
summarize, archive, reply, and send messages from the browser dashboard.

The integration reuses the OAuth client you already created for Google
Calendar (or you create one if Calendar isn't wired up). One client, one
consent screen, one token file on disk.

## 1. OAuth client (skip if already set up for Calendar)

Follow [CALENDAR-SETUP.md](CALENDAR-SETUP.md) section 1 to create a Desktop
OAuth client in your Google Cloud project. Same client_id and client_secret
work for both APIs.

You also need to enable the Gmail API in the same project:

- APIs & Services -> Library -> search "Gmail API" -> Enable.

## 2. Run the auth helper

```
node server/bin/google-auth.js --gmail
```

If you already have a `~/.config/glance/google-token.json` with calendar
scope, the helper prompts you to reuse the client_id; press Enter and it
will only ask Google for the Gmail scope (alongside whatever you already
have).

To request both scopes in one go:

```
node server/bin/google-auth.js
```

The browser tab opens for consent; click Allow. The token file is overwritten
with the new refresh_token and the granted `scopes` array. (Google issues a
new refresh_token on every consent prompt, so make sure to allow the prompt
to complete.)

## 3. Wire it up

Add to `~/.config/glance/config.json`:

```json
{
  "gmailBin":     "/absolute/path/to/glance/server/bin/gmail.js",
  "gmailMaxUnread": 20,
  "gmailBlacklist": {
    "fromPatterns":    ["notifications@github.com", "*@*.linkedin.com"],
    "subjectPatterns": ["[CRON]*"],
    "labelExcludes":   ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]
  }
}
```

Restart the backend. The INBOX column populates within ~60s (the cache TTL).

The INBOX widget is registered but disabled by default in the extension
layout. Open prefs -> Widgets, or use the in-dashboard edit mode (gear icon
in the topbar), to enable it.

## Blacklist

`fromPatterns` and `subjectPatterns` are simple `*`-glob, case-insensitive,
matched against the full From / Subject header. Anything that matches is
dropped from the inbox column before it reaches the UI.

`labelExcludes` is reserved for future use; the defaults already filter the
"Promotions", "Social", and "Forums" categories using the Gmail query
itself.

Useful patterns:

- `*@*.linkedin.com` -- everything from LinkedIn
- `notifications@github.com` -- GitHub mention/PR/issue mail
- `*-noreply@*` -- generic no-reply senders
- `Your * receipt` -- subscription receipts

## Subcommands (manual sanity check)

```
node server/bin/gmail.js list 10                 # 10 unread, TSV: id<TAB>ts<TAB>from<TAB>subject
node server/bin/gmail.js read    <id>            # JSON
node server/bin/gmail.js summarize <id>          # heuristic one-line summary
node server/bin/gmail.js mark <id> read|archive|trash
echo '{"to":"a@b.com","subject":"hi","body":"hi"}' | node server/bin/gmail.js send
```

## Endpoints (browser dashboard / API)

| Method | Path                                | Body                                                      |
|--------|-------------------------------------|-----------------------------------------------------------|
| GET    | `/api/inbox/<id>`                   | -- (returns full message)                                 |
| POST   | `/api/inbox/<id>/summarize`         | -- (returns one-line summary)                             |
| POST   | `/api/inbox/<id>/mark`              | `{ "action": "read" \| "archive" \| "trash" }`            |
| POST   | `/api/inbox/send`                   | `{ to, subject, body, cc?, bcc?, reply_to_id? }`          |

`/api/state` now includes an `inbox` block: `{ authed, fetch_failed, unread_count, items }`.

## Re-auth

Delete `~/.config/glance/google-token.json` and rerun `google-auth.js`.

## Troubleshooting

- **"Gmail scope not granted"**: token file exists but only has
  `calendar.readonly`. Rerun `node server/bin/google-auth.js --gmail`.
- **"insufficient authentication scopes"**: scope changed but Google still
  has the old grant cached. Revoke at
  <https://myaccount.google.com/permissions> and rerun the helper.
- **Messages show up that should be blacklisted**: glob is anchored
  (`*@evil.com`, not `evil.com`). Patterns are case-insensitive but
  whitespace-sensitive against the trimmed header value.

## Privacy

- Tokens stored mode 600 at `~/.config/glance/google-token.json`.
- All Gmail API traffic is direct from your machine to Google.
- The dashboard backend is bound to `127.0.0.1` only; nothing about your
  mail leaves your machine.
- No body content is cached -- the on-disk cache stores only the unread
  list (id, timestamp, from, subject). Full bodies are fetched on demand
  when you click read or summarize.
