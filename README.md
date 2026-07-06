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
