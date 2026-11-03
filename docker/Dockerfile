# Dockerfile for containerised Asterisk PBX for Twilio SIP trunking
#
# This image is designed to:
# - Run Asterisk on a small, security-supported base image.
# - Use environment variables to inject Twilio SIP trunk credentials securely at runtime.
# - Support both local development (with bind-mounted configuration) and production/PI usage (with configs baked in).
# - Serve as the build context for multi-architecture images (amd64 + arm variants) via Docker Buildx / GitHub Actions.

# Base: Alpine 3.22, which packages Asterisk 20 (LTS) in its main repository
# for x86_64, armv7 and aarch64 — the three platforms this image is built
# for. Debian stopped shipping Asterisk after bullseye (11), and bullseye
# left security support in August 2026: its security archive now returns
# 404 for every package, so the previous debian:bullseye-slim base could no
# longer be built, let alone patched. Alpine's asterisk package tracks the
# upstream LTS branch and receives security updates for the life of the
# release.
FROM alpine:3.22

# ------------------------------
# Core system preparation
# ------------------------------
# Packages chosen:
#   - asterisk: core PBX server (chan_pjsip, app_confbridge, outbound
#     registration and the rest of the standard module set).
#   - asterisk-sample-config: the full default /etc/asterisk so Asterisk
#     starts with sane logger/asterisk/indications config; the files this
#     image owns are copied over the samples below.
#   - asterisk-sounds-en: basic English sound prompts (beep, ss-noservice,
#     pm-invalid-extension and the ConfBridge join/leave announcements).
#   - asterisk-srtp: res_srtp, required for media_encryption=sdes on the
#     Twilio endpoint.
#   - bash: the entrypoint is a bash script.
#   - gettext-envsubst: supplies `envsubst` for pjsip.conf templating.
#   - openssl, ca-certificates: self-signed PJSIP TLS cert generation and
#     the CA bundle used to verify Twilio's certificate.
#   - iproute2, procps-ng, less, nano: lightweight troubleshooting and
#     on-container editing tools.
RUN set -eux; \
    apk add --no-cache \
        asterisk \
        asterisk-sample-config \
        asterisk-sounds-en \
        asterisk-srtp \
        bash \
        gettext-envsubst \
        openssl \
        ca-certificates \
        iproute2 \
        procps-ng \
        less \
        nano

# Some Asterisk configurations expect a default MOH directory. In container
# deployments we don't use MOH, but creating the directory avoids noisy startup
# warnings like: "Error opening directory - /var/lib/asterisk/moh".
RUN set -eux; \
    mkdir -p /var/lib/asterisk/moh /usr/share/asterisk/moh

# ------------------------------
# Asterisk user and permissions
# ------------------------------
# Asterisk runs under its own user for security. The package creates the
# user and group; we explicitly ensure that the directories Asterisk writes
# to (config, logs, spool, run, astdb) are owned correctly.
RUN set -eux; \
    mkdir -p /etc/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk /var/lib/asterisk /var/lib/asterisk/keys; \
    chown -R asterisk:asterisk /etc/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk /var/lib/asterisk

# ------------------------------
# Copy Asterisk configuration templates
# ------------------------------
# We copy the configuration files from the build context into the image.
#
# In development on macOS we will usually bind-mount ./asterisk over
# /etc/asterisk (via docker-compose.dev.yml) so that changes on the host are
# reflected live inside the container. In production/PI usage, we can rely on
# these baked-in defaults or override them via a volume if desired.
COPY --chown=asterisk:asterisk asterisk/pjsip.conf.template /etc/asterisk/pjsip.conf.template
COPY --chown=asterisk:asterisk asterisk/extensions.conf        /etc/asterisk/extensions.conf
COPY --chown=asterisk:asterisk asterisk/modules.conf           /etc/asterisk/modules.conf
COPY --chown=asterisk:asterisk asterisk/rtp.conf               /etc/asterisk/rtp.conf
COPY --chown=asterisk:asterisk asterisk/confbridge.conf  /etc/asterisk/confbridge.conf

# ------------------------------
# Copy entrypoint script
# ------------------------------
# The entrypoint is responsible for:
# - Validating required Twilio environment variables.
# - Rendering pjsip.conf from pjsip.conf.template using envsubst.
# - Starting Asterisk in the foreground so the container behaves well under
#   Docker / Compose / Kubernetes supervision.
COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

# ------------------------------
# Expose SIP and RTP ports
# ------------------------------
# SIP:
#   - 5060/udp: traditional UDP SIP signalling.
#   - 5060/tcp: TCP SIP signalling in case it is required.
#   - 5061/tcp: TLS SIP signalling (the Twilio trunk transport).
# RTP (media):
#   - 10000-10100/udp: typical RTP port range used by Asterisk; this can be
#     expanded or tuned in rtp.conf if necessary.
EXPOSE 5060/udp 5060/tcp 5061/tcp 10000-10100/udp

# ------------------------------
# Set working directory
# ------------------------------
# Using / as the working directory is fine for this sort of service container,
# but we could alternatively choose /etc/asterisk. We keep the default here as
# the entrypoint script is self-contained and uses absolute paths.
WORKDIR /

# ------------------------------
# Container entrypoint and default command
# ------------------------------
# We use the entrypoint to perform validation and templating actions before
# starting Asterisk. No additional CMD is required, as the entrypoint is
# responsible for launching the actual PBX process.
ENTRYPOINT ["/entrypoint.sh"]

# No CMD is specified because the entrypoint script invokes the long-running
# Asterisk process directly (in the foreground) after performing its checks.
