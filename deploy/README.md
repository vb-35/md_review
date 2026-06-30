## Server Usage

This app runs directly with `gunicorn`. Use `md-reviewctl` to start it, check status, and stop it.

## Operator Contract

- Deployed installs must set `SECRET_KEY` and `TOKEN_LOGIN_SECRET`.
- Writable paths must exist for the database and Flask session directory.
- `md-reviewctl token` is the intended login-token command for any local user.
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
- prints a short-lived signed login URL for the current SSH user

Typical output includes:

```text
SSH tunnel: ssh -L 18080:127.0.0.1:18080 youruser@yourhost
Open this URL in the browser that is using your SSH tunnel:
http://127.0.0.1:18080/?token=...
```

Open that printed URL in the browser that uses the tunnel. The token is exchanged for a normal session and then removed from the address bar.

If you need another fresh login URL later:

```bash
./md-reviewctl token
./md-reviewctl login-url
```

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
- The signed login URL is the intended way to carry the current SSH user into the browser session.
- If `md-reviewctl` is installed outside the repo, set `MD_REVIEW_ROOT` to the project root or install it as a symlink.
