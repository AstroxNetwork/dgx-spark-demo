# DGX Ops Runbook

This runbook covers the restart-safe DGX demo stack flow for operators on a MacBook.

## Scope

The DGX stack is considered ready when these 6 services are healthy:

1. Ollama 35B
2. qwen-tts-rs
3. vLLM Qwen ASR
4. OpenViking
5. OpenClaw gateway
6. OneBox preview

The external browser entries are:

- `https://<current-dgx-ip>:8443`
- `https://<current-dgx-ip>:8444`

The operator only needs the current DGX host or IP.

## Remote Scripts

Run these from the repo root on the MacBook:

### 1. Check all 6 services

```bash
npm run dgx:check -- <current-dgx-ip-or-hostname>
```

### 2. Restart and bring up the full stack

```bash
npm run dgx:start -- <current-dgx-ip-or-hostname>
```

This flow will:

- sync the DGX repo to `origin/main`
- reinstall the managed systemd units
- restart the OneBox and Caddy services
- run the 6-service health check

### 3. Restart only the OpenClaw gateway

```bash
npm run dgx:gateway:restart -- <current-dgx-ip-or-hostname>
```

## Certificate Onboarding

### Download the DGX Caddy root certificate

```bash
npm run dgx:cert:download -- <current-dgx-ip-or-hostname>
```

This stores the certificate under:

```text
tmp/dgx-certs/dgx-caddy-root-<host>.crt
```

### Install the certificate on macOS

```bash
npm run dgx:cert:install:macos -- tmp/dgx-certs/dgx-caddy-root-<host>.crt
```

This installs the certificate into the macOS system keychain as a trusted root.

## Authentication

The scripts support either:

- existing SSH key access
- password-based SSH using `sshpass`

Optional environment variables:

- `DGX_USER`
- `DGX_PASSWORD`
- `DGX_REPO_DIR`

## Internal Networking Rules

The DGX-side stack must not depend on one fixed LAN IP.

Current behavior:

- internal service checks use `127.0.0.1`
- Vite preview proxies default to `127.0.0.1` when `DGX_HOST` is unset
- Caddy renders its browser-facing site addresses from the current primary IP at service start

## Reboot Recovery Expectation

After a DGX reboot:

1. `localclaw-onebox.service` must start the local runtime stack.
2. `localclaw-caddy.service` must start the public reverse proxy.
3. `npm run dgx:check -- <current-dgx-ip-or-hostname>` must pass.

## Verification Targets

Expected public checks:

- `https://<current-dgx-ip>:8443/health`
- `https://<current-dgx-ip>:8444/`
