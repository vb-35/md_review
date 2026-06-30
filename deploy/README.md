## Server Usage

This app runs directly with `gunicorn`. Use the scripts in `deploy/` to start it, check status, and stop it.

### Run

From the project root:

```bash
bash deploy/deploy.sh
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
bash deploy/print-login-url.sh
```

### Status

```bash
bash deploy/status.sh
```

Useful checks:

```bash
tail -f data/server.log
curl -I http://127.0.0.1:18080/
curl -s http://127.0.0.1:18080/api/auth/me
```

### Stop

```bash
bash deploy/stop.sh
```

### Notes

- The default port is `18080`.
- Logs are written to `data/server.log`.
- The signed login URL is the intended way to carry the current SSH user into the browser session.
- `deploy/deploy.sh` also prints the login URL when the server is already running.
