# Drive

A minimal local file browser for a server folder. No database, no accounts, no external runtime dependencies. The frontend is embedded into a single static Go binary.

## Features

- Browse, search, sort, upload, download, preview, edit, copy, move, and delete files.
- Markdown notes with an embedded offline renderer.
- Image, video, and audio previews.
- Any number of password-protected folders, configured in JSON.
- OLED-black Material You interface with inline SVG icons.
- Passwords stay in memory only and are never written to browser storage.

## Build

Go 1.22 or newer:

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o drive-app .
```

The result is a self-contained binary; the `web` folder is embedded.

## Configuration

Copy `config.example.json` to `config.json`:

```json
{
  "storage_dir": "/srv/drive",
  "listen": "127.0.0.1:8080",
  "protected_folders": [
    { "path": "admin", "password": "change-me" },
    { "path": "private/docs", "password": "change-me-too" }
  ]
}
```

- `storage_dir` is the folder served by the app. Relative paths are resolved against the config file location. The folder is created if missing.
- `listen` defaults to `127.0.0.1:8080`.
- `protected_folders` is optional. Each `path` is relative to `storage_dir` and protects that folder and its whole subtree. The deepest matching entry wins. Restart the service after editing a password.
- Passwords are stored in plaintext in the config. Run `chmod 600 config.json`.

Start it:

```bash
./drive-app -config config.json
```

If the app is exposed outside a trusted network, put it behind HTTPS (for example, a reverse proxy or VPN). Media URLs pass protected-folder passwords as query parameters because `<img>`, `<video>`, and `<audio>` cannot send custom headers.

## systemd

The included `drive-app.service` assumes:

- binary: `/opt/drive-app/drive-app`
- config: `/etc/drive-app/config.json`
- service user: `drive`
- storage: `/srv/drive`

Adjust paths in the unit if needed, then:

```bash
sudo useradd --system --home /opt/drive-app --shell /usr/sbin/nologin drive
sudo install -d -o drive -g drive /srv/drive /opt/drive-app
sudo install -d -o drive -g drive /etc/drive-app
sudo install -o drive -g drive -m 600 config.example.json /etc/drive-app/config.json
sudo install -m 755 drive-app /opt/drive-app/drive-app
sudo install -m 644 drive-app.service /etc/systemd/system/drive-app.service
sudo systemctl daemon-reload
sudo systemctl enable --now drive-app
```

Edit `/etc/drive-app/config.json` and run `sudo systemctl restart drive-app` after changing protected folders or passwords.

## Docker

```bash
docker build -t drive-app .
```

Prepare a config with `"storage_dir": "/drive"` and `"listen": "0.0.0.0:8080"`, then:

```bash
mkdir -p /srv/drive
docker run --rm -p 8080:8080 \
  -v /srv/drive:/drive:Z \
  -v "$PWD/config.json:/config/config.json:ro,Z" \
  drive-app
```

The final image is `scratch`; only the static binary and config template are included.
