## Server Usage

This app runs directly with `gunicorn`. Use `md-reviewctl` to start it, check status, and stop it.

## Operator Contract

- Deployed installs must set `SECRET_KEY`.
- Writable paths must exist for the database and Flask session directory.
- `md-reviewctl start` and `md-reviewctl stop` are intended to be restricted to sudoers when this is later wired into a real service install.

Example operator env file: `deploy/md-review.env.example`

### Run

From the project root:

```bash
./md-reviewctl start
```

What it does:

- starts the Flask app in the background
- prints the SSH tunnel command

Typical output includes:

```text
SSH tunnel: ssh -L 18080:127.0.0.1:18080 youruser@yourhost
Browser via tunnel: http://127.0.0.1:18080/
```

Open that URL in the browser that uses the tunnel, type an identifier, and the browser will remember it until logout.

### Status

```bash
./md-reviewctl status
```

Useful checks:

```bash
tail -f data/server.log
curl -I http://127.0.0.1:18080/
curl -s http://127.0.0.1:18080/api/auth/me
```

### Stop

```bash
./md-reviewctl stop
```

### Notes

- The default port is `18080`.
- Logs are written to `data/server.log`.
- Login is browser-local: enter any identifier and the browser will reuse it on refresh.
- If `md-reviewctl` is installed outside the repo, set `MD_REVIEW_ROOT` to the project root or install it as a symlink.
