#!/bin/sh
set -eu
# Generate a service-specific secret internally, never via command arguments
# or logs. Keep it across restarts in the private configuration volume.
/usr/local/searxng/.venv/bin/python - <<'PY'
import os, secrets, yaml
path = "/etc/searxng/settings.yml"
existing = {}
if os.path.exists(path):
    with open(path) as stream:
        existing = yaml.safe_load(stream) or {}
with open("/etc/forge-search/settings.yml") as stream:
    settings = yaml.safe_load(stream)
settings["server"]["secret_key"] = existing.get("server", {}).get("secret_key") or secrets.token_hex(32)
with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
    yaml.safe_dump(settings, stream)
PY
exec /usr/local/searxng/entrypoint.sh