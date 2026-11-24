# claude-spend

See where your Claude Code tokens go. One command, zero setup.

## Problem

 I've been using Claude Code every day for 3 months. I hit the usage limit almost daily, but had zero visibility into which prompts were eating my tokens. So I built claude-spend. One command, zero setup. 

## How does it look


<img width="1910" height="966" alt="Screenshot 2026-02-18 092727" src="https://github.com/user-attachments/assets/11cc7149-d4dd-4e44-a3a0-0b48e935b7bc" />

<img width="1906" height="966" alt="Screenshot 2026-02-18 093529" src="https://github.com/user-attachments/assets/537c3611-5794-41d2-864e-e368e6949812" />

<img width="1908" height="969" alt="Screenshot 2026-02-18 093647" src="https://github.com/user-attachments/assets/aaaa8ce5-2025-407d-8596-ea1965748691" />

<img width="1908" height="969" alt="Screenshot 2026-02-18 093647" src="https://github.com/user-attachments/assets/a9fde5e2-6e52-4bae-9b96-03655109aef6" />



## Install

```
npx claude-spend
```

That's it. Opens a dashboard in your browser.


## What it does

- Reads your local Claude Code session files (nothing leaves your machine)
- Shows token usage per conversation, per day, and per model
- Surfaces insights like which prompts cost the most and usage patterns


## Options

```
claude-spend --port 8080   # custom port (default: 3456)
claude-spend --no-open     # don't auto-open browser
```

## Team Dashboard

### Start the server (one person runs this)

```bash
git clone https://github.com/alessio-cmyk/claude-spend.git
cd claude-spend
npm install
DASHBOARD_PASSWORD=<viewer-password> ADMIN_PASSWORD=<admin-password> node src/team-server.js
```

### Access control

The team server holds everyone's prompts, so every API route requires authentication:

| Who | How | Can access |
|---|---|---|
| Dashboard viewers | `DASHBOARD_PASSWORD`, entered on the sign-in page (7-day HttpOnly session cookie) | Dashboard and all read APIs |
| Admins | `ADMIN_PASSWORD` as a `Bearer` token (admin panel) | Everything, including key management |
| Developers' CLI | Their personal API key (`--key`) | Syncing, and reading only their own data for sync diffs |

Without `DASHBOARD_PASSWORD` the dashboard can't be signed into (it fails closed). Rotating it signs everyone out. `--pull <url>` from a protected server needs `CLAUDE_SPEND_REMOTE_ADMIN_PASSWORD`.

### Adding team members (no cloning needed)

Generate API keys from a user list (optional — without this, anyone can sync):

```bash
node src/generate-keys.js users
```

Each team member just runs the command from the output:

```bash
npx claude-spend --sync --key <your-key> --server http://your-server:3457
```

The key identifies who you are — no need to pass `--name`. To sync daily, add an alias:

```bash
alias claude-sync='npx claude-spend --sync --key <your-key> --server http://your-server:3457'
```

Then just run `claude-sync` each day.

### Recommended: auto-sync after every session

Install the CLI globally once, so syncing doesn't re-download the package each time (`npx --yes github:...` takes ~18 s per run):

```bash
npm i -g github:alessio-cmyk/claude-spend
```

Then add a Claude Code Stop hook in `~/.claude/settings.json`. Mark it `"async": true` so the sync runs in the background instead of holding up your next prompt:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "claude-spend --sync --key <your-key> --server http://your-server:3457",
            "async": true
          }
        ]
      }
    ]
  }
}
```

`claude-spend setup --key <your-key> --server <url>` writes this hook for you, using the global binary when it's installed. If you already have an `npx` hook, re-run setup after the global install and it will switch the hook over.

### Interactive setup wizard (optional)

If you cloned the repo, you can also run the setup wizard:

```bash
node src/setup.js
```

## Privacy

All data stays local. claude-spend reads files from `~/.claude/` on your machine and serves a dashboard on localhost. No data is sent anywhere.

## License

MIT
