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
4. Take the project lock, open an affected Markdown file, and select **Review**. The proposal appears in **Version History** as `Proposed · codex`; diff it against the selected published base and accept or refuse its chunks. Every decision is recomputed live in the editor and preview, but the project file and version history remain unchanged until you use the normal **Save** button. Save each proposal file after its final decisions, including an unchanged all-refused file so the review records that decision snapshot.
5. Open **Revision proposals** on the project dashboard to decide any comment actions and review each file's saved state. Once every item is decided and every file is saved, select **Close review**. Closing applies accepted comment actions without creating another file version. Decisions remain visible on the closed proposal, which its author or the project owner may delete.

A proposal changes the live project only through normal per-file saves. Those saves create ordinary versions attributed to the saving editor; the proposal remains pending until it is closed. Unrelated project commits or referenced comment-thread changes make a proposal stale. Project locks are five-minute leases, and the browser refreshes a held editing lease every minute. Legacy proposals published by older versions of the app remain retained as audit history.

The MCP server intentionally exposes read operations and proposal submission only. It cannot decide or close reviews, take a persistent lock, or save a live file. Authentication remains the app's existing trusted username mechanism.
