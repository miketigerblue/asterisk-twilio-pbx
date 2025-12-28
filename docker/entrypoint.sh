#!/usr/bin/env bash

# Entry point for the Asterisk/Twilio PBX container.
#
# Responsibilities:
# - Enforce that all required environment variables for Twilio SIP trunking
#   are present before Asterisk starts.
# - Render /etc/asterisk/pjsip.conf from /etc/asterisk/pjsip.conf.template
#   using envsubst so that credentials and domain are injected at runtime
#   rather than baked into the image.
# - Emit a small banner for logging/diagnostics.
# - Start Asterisk in the foreground under the dedicated asterisk user and
#   group, so the container supervises the PBX process correctly.

# Exit immediately if any command fails (-e), treat unset variables as an
# error (-u), and ensure that errors in pipelines are not masked (pipefail).
set -euo pipefail

# ------------------------------
# Helper: log functions
# ------------------------------
log_info() {
  # Simple informational log helper with a consistent prefix.
  echo "[entrypoint][INFO] $*"
}

log_error() {
  # Simple error log helper that writes to standard error so that log
  # aggregators can distinguish failures.
  echo "[entrypoint][ERROR] $*" >&2
}

# ------------------------------
# Validate required environment variables
# ------------------------------
# We require Twilio SIP trunk credentials to be provided via environment
# variables. This ensures that secrets are not stored in the image or in
# version control. If any are missing, we fail fast with a clear message.
REQUIRED_VARS=(
  "TWILIO_USERNAME"  # Twilio SIP trunk username (often the same as account SID or trunk auth user).
  "TWILIO_PASSWORD"  # Twilio SIP trunk password/secret.
  "TWILIO_DOMAIN"    # Twilio SIP domain, e.g. youraccount.sip.twilio.com.
  "GW_1001_PASSWORD" # Local SIP endpoint password for extension 1001.
)

missing=false
for var_name in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var_name:-}" ]; then
    log_error "Required environment variable '${var_name}' is not set."
    missing=true
  fi
done

if [ "${missing}" = "true" ]; then
  log_error "One or more required environment variables are missing; refusing to start Asterisk."
  exit 1
fi

# ------------------------------
# Ensure TLS certificate exists (for SIP TLS transport)
# ------------------------------
TLS_CERT_DIR="/etc/asterisk/keys"
TLS_CERT_PEM="${TLS_CERT_DIR}/asterisk.pem"

mkdir -p "${TLS_CERT_DIR}"

# Generate a self-signed cert if none is present.
# This is sufficient for outbound TLS to Twilio unless you have enabled
# mutual TLS (client certificate verification) on the Twilio trunk.
if [ ! -f "${TLS_CERT_PEM}" ]; then
  log_info "Generating self-signed TLS cert for PJSIP (TLS transport)..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${TLS_CERT_PEM}" -out "${TLS_CERT_PEM}" \
    -days 3650 -subj "/CN=asterisk" >/dev/null 2>&1
  chown -R asterisk:asterisk "${TLS_CERT_DIR}"
  chmod 600 "${TLS_CERT_PEM}"
fi

# ------------------------------
# Render pjsip.conf from template
# ------------------------------
# We use envsubst from gettext-base to substitute environment variables in the
# pjsip.conf template at container start time. This means we never have to
# commit secrets to the repository, and Twilio credentials can be rotated by
# simply restarting the container with new environment values.
PJSIP_TEMPLATE="/etc/asterisk/pjsip.conf.template"
PJSIP_RENDERED="/etc/asterisk/pjsip.conf"

if [ ! -f "${PJSIP_TEMPLATE}" ]; then
  log_error "PJSIP template file '${PJSIP_TEMPLATE}' not found; cannot generate configuration."
  exit 1
fi

log_info "Rendering PJSIP configuration from template..."
# Use envsubst to substitute all environment variables into the template. This
# ensures that both the Twilio credentials (TWILIO_*) and any additional
# endpoint secrets such as GW_1001_PASSWORD are rendered correctly without us
# having to maintain a hard-coded list of variable names here.
#
# Security note: this only affects the contents of pjsip.conf inside the
# container; secrets remain provided via environment variables and are not
# committed to the image or repository.
envsubst < "${PJSIP_TEMPLATE}" > "${PJSIP_RENDERED}"

# Ensure the rendered configuration is owned by the asterisk user for
# consistency, particularly when running with a bind-mounted /etc/asterisk in
# development.
chown asterisk:asterisk "${PJSIP_RENDERED}"

# ------------------------------
# Banner and environment summary
# ------------------------------
# The banner is intentionally simple to avoid leaking secrets; it shows only
# non-sensitive contextual information.
log_info "Starting Asterisk/Twilio PBX container"
log_info "Date: $(date -Iseconds)"
log_info "Twilio domain configured: ${TWILIO_DOMAIN}"

# ------------------------------
# Start Asterisk in the foreground
# ------------------------------
# We run Asterisk in the foreground (-f) under the asterisk user and group so
# that:
# - Docker sees Asterisk as PID 1 and can supervise it cleanly.
# - File ownership aligns with the asterisk account.
# If your packaging uses a different user/group, adjust the -U/-G flags
# accordingly.
log_info "Launching Asterisk..."
exec asterisk -f -U asterisk -G asterisk
