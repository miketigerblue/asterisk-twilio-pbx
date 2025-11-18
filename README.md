# Asterisk Twilio PBX (Docker, Raspberry Pi, Ansible, GitHub Actions)

This repository provides a fully containerised Asterisk PBX, configured to
place outbound calls via Twilio SIP Trunking. It is designed to:

- Run locally on macOS for development.
- Build multi-architecture Docker images (amd64 + ARM) and push them to GHCR.
- Deploy to a Raspberry Pi using both GitHub Actions (CI/CD) and an Ansible
  playbook that you can also run manually from your Mac.

All configuration is driven by environment variables so that Twilio credentials
remain outside the image and the git repository.

---

## High-level Architecture

The following diagram summarises the main components and flows:

```text
+-------------------+        +-------------------------+
|   Mac (Dev Host)  |        |        GitHub          |
|                   |        |  (Repo + Actions +     |
| - Docker Desktop  | push   |   GHCR Container Reg)  |
| - docker compose  +------->+-------------------------+
| - Ansible (CLI)   |        |                         |
+---------+---------+        |  build-and-push.yml     |
          |                  |    - builds multi-arch  |
          | ansible-playbook |    - pushes image       |
          v                  |                         |
+-------------------+        |  deploy-to-pi.yml       |
|   Raspberry Pi    |<-------+    - runs Ansible       |
|   (PBX Host)      |   pull |      playbook           |
|                   |   from +-------------------------+
| - Docker Engine   |   GHCR
| - docker compose  |
+---------+---------+
          |
          | SIP / RTP
          v
+-------------------+       +-------------------------+
|   Twilio SIP      |<----->|  Bermuda / International|
|   Trunking        |  PSTN |  Destinations           |
+-------------------+       +-------------------------+
```

- **Local development:** You run Asterisk in Docker on your Mac with
  `docker compose -f compose/docker-compose.dev.yml up`, using host networking
  and bind-mounted configuration.
- **CI build:** GitHub Actions builds a multi-arch image and pushes it to
  `ghcr.io/<OWNER>/asterisk-twilio-pbx:latest`.
- **Deployment:** Ansible (run locally or via GitHub Actions) connects to your
  Raspberry Pi, ensures Docker is available, copies a Compose file, and
  launches the PBX container which registers to Twilio.

---

## Repository Layout

```text
asterisk-twilio-pbx/
  asterisk/
    pjsip.conf.template   # Twilio PJSIP trunk definition, templated via env vars.
    extensions.conf        # Dialplan (Bermuda + general international route).
    modules.conf           # Modules to load / not load, focused on PJSIP and RTP.
  docker/
    Dockerfile             # Debian-slim based Asterisk image with envsubst support.
    entrypoint.sh          # Validates env, renders pjsip.conf, starts Asterisk.
  compose/
    docker-compose.dev.yml # Mac dev compose (host networking, bind-mounted configs).
    docker-compose.pi.yml  # Pi deploy compose (GHCR image, explicit ports).
  ansible/
    inventory.ini          # [pbx_pi] group and SSH connection settings.
    playbook-pbx.yml       # Top-level play targeting pbx_pi.
    group_vars/
      pbx_pi.yml           # Project directory and GHCR image reference.
    roles/
      pbx_pi/
        tasks/
          main.yml         # Install Docker, copy compose file, run docker compose.
        files/
          docker-compose.pi.yml  # Compose file as copied to the Pi.
        vars/
          main.yml         # Minimal role defaults (packages, service names).
  .env.example             # Sample env vars (Twilio credentials, domain).
  .gitignore               # Ignore .env, logs, runtime dirs, local overrides.
  README.md                # This documentation.
  .github/
    workflows/
      build-and-push.yml   # Build + push multi-arch image to GHCR.
      deploy-to-pi.yml     # Run Ansible playbook to deploy to Pi.
```

---

## Getting Started (macOS development)

### 1. Prerequisites

On your Mac you will need:

- Docker Desktop (or another Docker engine providing `docker` and
  `docker compose`).
- A Twilio account with a SIP trunk configured (username, password, domain).

### 2. Configure environment variables

1. Copy the example env file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set:

   - `TWILIO_USERNAME` – your Twilio SIP trunk username.
   - `TWILIO_PASSWORD` – your Twilio SIP trunk password.
   - `TWILIO_DOMAIN` – your Twilio SIP domain (e.g. `youraccount.sip.twilio.com`).

The entrypoint script will refuse to start Asterisk if any of these are
missing.

### 3. Run the PBX locally

From the project root:

```bash
docker compose -f compose/docker-compose.dev.yml up --build
```

This will:

- Build the Asterisk image from `docker/Dockerfile`.
- Start a container using host networking.
- Bind-mount `./asterisk` into `/etc/asterisk` so you can tweak configuration
  in real time.

To tear down the dev stack:

```bash
docker compose -f compose/docker-compose.dev.yml down
```

### 4. Testing calls

- Point a SIP softphone on your Mac at `localhost:5060` (or the host IP if
  using another device on the LAN).
- Use the `outbound` context and dial a Bermuda number matching the pattern
  `001441XXXXXX` or another international number matching `00X.` to send calls
  via Twilio.

> **Note:** For proper caller ID, emergency calling, and compliance, you
> should configure Twilio and Asterisk according to local regulations and your
> use-case. This repo focuses on the containerisation and deployment aspects.

---

## Ansible Deployment to Raspberry Pi

The Ansible role `pbx_pi` automates preparing your Raspberry Pi and launching
the PBX container using `docker compose`.

### 1. Install Ansible on your Mac

On macOS, a common approach is:

```bash
# Using Homebrew
brew install ansible
```

Or via pip (inside a virtual environment if you prefer):

```bash
python3 -m pip install --user ansible
```

### 2. Configure the inventory

Edit `ansible/inventory.ini` and replace the placeholders:

```ini
[pbx_pi]
pbxpi ansible_host=PBX_PI_HOST

[pbx_pi:vars]
ansible_user=PBX_PI_USER
ansible_ssh_private_key_file=~/.ssh/id_rsa
```

- Replace `PBX_PI_HOST` with your Pi's IP or DNS name.
- Replace `PBX_PI_USER` with your SSH username (e.g. `pi`).
- Ensure `ansible_ssh_private_key_file` points at a private key that can
  access the Pi without a password prompt.

### 3. Review group variables

In `ansible/group_vars/pbx_pi.yml` you can adjust:

- `pbx_project_dir` – where the compose file and env file will live on the Pi
  (default `/opt/asterisk-twilio-pbx`).
- `pbx_image` – the GHCR image to deploy (update `<OWNER>` to your GitHub
  username or organisation).

Role-level defaults in `ansible/roles/pbx_pi/vars/main.yml` control package
names and the Docker service name for Debian-based Pis.

### 4. Run the playbook from your Mac

From the project root:

```bash
ansible-playbook -i ansible/inventory.ini ansible/playbook-pbx.yml
```

The play will:

1. Install Docker, docker-compose plugin, and git on the Pi (if not present).
2. Ensure the Docker service is enabled and running.
3. Create the project directory (e.g. `/opt/asterisk-twilio-pbx`).
4. Copy `docker-compose.pi.yml` into that directory.
5. Create a placeholder `.env` file on the Pi (if one is not present).
6. Use `docker compose` to pull the PBX image and bring the stack up.

After the first run, SSH to the Pi and edit
`/opt/asterisk-twilio-pbx/.env` with your real Twilio credentials.
Re-run the playbook any time you change the image or Compose file; it is
idempotent and will only make changes when needed.

---

## GitHub Actions / CI/CD

Two workflows in `.github/workflows/` wire up CI and deployment.

### build-and-push.yml

This workflow:

1. Triggers on pushes to the `main` branch.
2. Checks out the repository.
3. Sets up QEMU for cross-architecture emulation.
4. Sets up Docker Buildx.
5. Logs in to GHCR using `${{ github.actor }}` and `GITHUB_TOKEN`.
6. Builds the PBX image for `linux/amd64`, `linux/arm/v7`, and `linux/arm64`.
7. Pushes the result as:

   ```text
   ghcr.io/${{ github.repository_owner }}/asterisk-twilio-pbx:latest
   ```

You may later add additional tags (e.g. SHA-based tags or semantic versions)
if you need more sophisticated release management.

### deploy-to-pi.yml

This workflow:

1. Can be triggered manually (`workflow_dispatch`) and also on pushes to
   `main` (if you keep that trigger enabled).
2. Checks out the repo.
3. Sets up Python and installs Ansible.
4. Writes the SSH private key from the `PI_SSH_PRIVATE_KEY` secret to
   `~/.ssh/id_rsa` and configures SSH to skip host key prompts (you can
   tighten this if desired).
5. Optionally replaces `PBX_PI_HOST` and `PBX_PI_USER` placeholders in
   `ansible/inventory.ini` with values from the `PI_HOST` and `PI_USER`
   secrets.
6. Runs `ansible-playbook -i ansible/inventory.ini ansible/playbook-pbx.yml`.

### Required GitHub secrets

Configure the following secrets in your GitHub repository settings:

- `PI_HOST` – IP address or DNS name of your Raspberry Pi.
- `PI_USER` – SSH username for the Pi.
- `PI_SSH_PRIVATE_KEY` – Private SSH key with access to the Pi.

Twilio credentials are *not* stored in GitHub secrets in this design; they are
managed via `.env` files on your Mac and on the Pi. If you prefer to centralise
secrets, you could extend the workflows and Ansible role to template `.env`
files directly from GitHub secrets or Ansible Vault.

---

## Security Notes

This project is intended as a starting point. For production or internet-
exposed use, consider at least the following:

1. **Do not expose SIP/RTP openly:**
   - Use firewall rules on your router and on the Pi to limit IP ranges that
     can reach ports 5060/5061 and 10000–10100.
   - Twilio publishes its SIP signalling and media IP ranges; you can
     restrict inbound traffic accordingly where feasible.

2. **Protect credentials:**
   - Keep `.env` files out of git (already enforced via `.gitignore`).
   - Rotate Twilio credentials if you suspect any compromise.
   - Consider using Ansible Vault or an external secrets manager for
     production deployments.

3. **Consider TLS/SRTP:**
   - The current configuration uses UDP/TCP SIP without TLS and plain RTP.
   - For higher security, configure PJSIP TLS transports and SRTP (encrypted
     media) once your environment supports it.

4. **Limit Asterisk modules and features:**
   - `modules.conf` is trimmed to disable many unused modules, but you should
     review it whenever you add functionality to ensure only necessary
     modules are loaded.

5. **Monitor and log appropriately:**
   - Centralise logs if this PBX will be used in anger.
   - Consider fail2ban or equivalent on the Pi to help mitigate brute-force
     SIP attacks.

---

## Git & GitHub Setup

This repository is already structured to be initialised as a git repository.
After you have reviewed or modified the files, run the following from the
project root to create your local git repo and make the initial commit:

```bash
git init

git add .

git commit -m "Initial containerised Asterisk/Twilio PBX with Ansible deployment"
```

Next, create a new repository on GitHub (for example
`github.com/<USER>/asterisk-twilio-pbx`). Then add it as a remote and push the
`main` branch:

```bash
git branch -M main

git remote add origin git@github.com:<USER>/asterisk-twilio-pbx.git

git push -u origin main
```

Once pushed, GitHub Actions will start building and publishing the PBX image to
GHCR, and you can use the `Deploy PBX to Raspberry Pi` workflow to roll out
updates to your Pi.
