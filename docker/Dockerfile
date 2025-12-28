# Dockerfile for containerised Asterisk PBX for Twilio SIP trunking
#
# This image is designed to:
# - Run Asterisk on a minimal Debian base image for a smaller footprint.
# - Use environment variables to inject Twilio SIP trunk credentials securely at runtime.
# - Support both local development (with bind-mounted configuration) and production/PI usage (with configs baked in).
# - Serve as the build context for multi-architecture images (amd64 + arm variants) via Docker Buildx / GitHub Actions.

# We use a specific Debian slim release (bullseye) rather than the moving
# `stable` tag. Asterisk has been removed from newer Debian releases, but
# Debian 11 (bullseye) still ships the `asterisk` packages we rely on.
# Pinning to bullseye-slim ensures `apt-get install asterisk` works reliably
# across architectures while keeping the image reasonably up to date.
FROM debian:bullseye-slim

# ------------------------------
# Core system preparation
# ------------------------------
# - Update package index.
# - Install Asterisk and common supporting packages.
# - Install gettext-base to provide `envsubst` for templating pjsip.conf.
# - Clean up apt caches to keep the image smaller.
RUN set -eux; \
    apt-get update; \
    # Install Asterisk, sounds, and useful debugging/tools packages.
    # Packages chosen:
    #   - asterisk: core PBX server.
    #   - asterisk-core-sounds-en: basic English sound prompts.
    #   - asterisk-modules: common additional modules.
    #   - iproute2: useful for network debugging inside the container.
    #   - net-tools: includes netstat, ifconfig, etc. for troubleshooting.
    #   - vim-tiny, nano, less: lightweight tools for on-container editing and viewing.
    #   - procps: provides ps/top for process inspection.
    #   - gettext-base: supplies `envsubst` for configuration templating.
    apt-get install -y --no-install-recommends \
        asterisk \
        asterisk-core-sounds-en \
        asterisk-modules \
        iproute2 \
        net-tools \
        vim-tiny \
        nano \
        less \
        procps \
        gettext-base \
        ca-certificates \
        openssl; \
    # Remove apt lists to reduce image size.
    rm -rf /var/lib/apt/lists/*

# ------------------------------
# Asterisk user and permissions
# ------------------------------
# Asterisk typically runs under its own user for security. The package will
# usually create this user and group, but we explicitly ensure that the
# directories we care about are owned correctly.
RUN set -eux; \
    # Ensure configuration and runtime directories exist and are owned by the
    # asterisk user so that Asterisk can write logs, spool, etc.
    mkdir -p /etc/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk; \
    chown -R asterisk:asterisk /etc/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk

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

# ------------------------------
# Copy entrypoint script
# ------------------------------
# The entrypoint is responsible for:
# - Validating required Twilio environment variables.
# - Rendering pjsip.conf from pjsip.conf.template using envsubst.
# - Starting Asterisk in the foreground so the container behaves well under
#   Docker / Compose / Kubernetes supervision.
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ------------------------------
# Expose SIP and RTP ports
# ------------------------------
# SIP:
#   - 5060/udp: traditional UDP SIP signalling.
#   - 5060/tcp: TCP SIP signalling in case it is required.
#   - 5061/tcp: reserved for future TLS SIP signalling.
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
