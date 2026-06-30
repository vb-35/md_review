## Server Deploy Without Docker

This app runs directly with `gunicorn`. The frontend is bundled into the Flask app, so the same server process serves both the API and the web UI.

### 1. Install Python

On the server, install:

```bash
sudo apt update
sudo apt install -y python3 python3-venv
```

### 2. Copy the project

Copy this whole project directory to the server.

### 3. Start the server

From the project root:

```bash
bash deploy/deploy.sh
```

Optional environment variables:

```bash
PORT=18080
LOCAL_AUTH=off
DATABASE_PATH=/absolute/path/to/md_review.db
SESSION_FILE_DIR=/absolute/path/to/flask_session
```

The script will:

- create `.venv` if needed
- install `server/requirements.txt`
- store runtime data in `data/`
- generate and reuse a private Flask session secret in `data/secret_key`
- start `gunicorn` in the background

### 4. Access it from your machine

Use the same pattern that worked for `voicebox`: SSH port forwarding.

From your local machine:

```bash
ssh -L 18080:127.0.0.1:18080 youruser@yourhost
```

Then open in your local browser:

```text
http://127.0.0.1:18080/
```

This avoids needing firewall changes on the server.

### 5. Check server status

```bash
bash deploy/status.sh
```

Useful checks:

```bash
tail -f data/server.log
curl -I http://127.0.0.1:18080/
curl -s http://127.0.0.1:18080/api/auth/me
```

### 6. Stop it

```bash
bash deploy/stop.sh
```

### Notes

- The default port is `18080`.
- Logs are written to `data/server.log`.
- The database defaults to `data/md_review.db`.
- The secret key is used by Flask to sign session cookies. You do not need to set it manually unless you want to manage it yourself.
- `deploy/status.sh` exits non-zero if the process is down or stale.
- `LOCAL_AUTH=on` means any non-empty username/password is accepted. That is only suitable for a trusted LAN demo.
- With `LOCAL_AUTH=off`, authentication expects Linux PAM to be available on the host.
