# md_review

Simple web app for reviewing Markdown documents.

## Quick install

Requirements:

- Python 3
- `python3-venv`

Clone the repo and start the app:

```bash
git clone <your-repo-url> md_review
cd md_review
./md-reviewctl start
```

`md-reviewctl` will:

- create `.venv` if needed
- install Python dependencies from `server/requirements.txt`
- start the app in the background
- print the local URL and SSH tunnel command

Then open the printed browser URL, usually:

```text
http://127.0.0.1:18080/
```

## Useful commands

Check status:

```bash
./md-reviewctl status
```

Stop the app:

```bash
./md-reviewctl stop
```

Watch logs:

```bash
tail -f data/server.log
```

## Notes

- Default port: `18080`
- App data lives under `data/`
- If `md-reviewctl` is run from outside the repo, set `MD_REVIEW_ROOT` to the project root

For more deployment-oriented notes, see [deploy/README.md](/home/vbordier/md_review/deploy/README.md).


## Codex revision proposals

Codex connects through a local stdio MCP server which calls the app's HTTP API. It does not read or write the managed project directories or database directly.

After updating the app, restart it so `md-reviewctl` installs the MCP dependency:

```bash
./md-reviewctl stop
./md-reviewctl start
```

Add this server to `~/.codex/config.toml`, replacing `/absolute/path/md_review` with this checkout's absolute path:

```toml
[mcp_servers.md_review]
command = "/absolute/path/md_review/.venv/bin/python"
args = ["/absolute/path/md_review/server/md_review_mcp.py"]
env = { MD_REVIEW_URL = "http://127.0.0.1:18080", MD_REVIEW_USERNAME = "codex" }
```

If the app uses `APP_BASE_PATH`, include it in `MD_REVIEW_URL`, for example `http://127.0.0.1:18080/md-review`.

Set up a project once:

1. Restart Codex and ask it to call `list_projects`. This logs in as `codex` and creates that app user if necessary.
2. In the browser, open the project as its owner and share it with `codex` as an editor.
3. Ask Codex to read the project, its version history, and open comment threads, then submit a revision proposal.
4. Open an affected Markdown file and select **Review**. The proposal appears in **Version History** as `Proposed · codex`; diff it against the selected published base and accept or refuse its chunks. These choices review the proposal without changing the editor or live file.
5. Open **Revision proposals** on the project dashboard to review any comment actions and the grouped proposal status, then publish the accepted items. The app creates one Git commit and records new file versions under the Codex author, with the human reviewer recorded on the proposal.

A proposal never changes the live project. The proposal author or project owner can permanently delete any unpublished proposal; published proposals remain as audit history. A proposal becomes stale if the project commit or a referenced comment thread changes, in which case Codex must generate a new proposal from the current state. Project locks are five-minute leases; the browser refreshes a held editing lease every minute, while Codex and proposal publication release their temporary leases immediately.

The MCP server intentionally exposes read operations and proposal submission only. It cannot approve, reject, publish, take a persistent lock, or save a live file. Authentication remains the app's existing trusted username mechanism.
