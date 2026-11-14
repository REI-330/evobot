#!/bin/bash

# Root-side container identity helpers. This file is copied into the image and
# sourced from the fixed /app/session-permissions.sh path by entrypoint.sh.
# Nothing here accepts a path or helper override from the runtime env.

EVOBOT_INTERNAL_IDENTITY_MODE=unconfigured
EVOBOT_INTERNAL_RUNTIME_UID=
EVOBOT_INTERNAL_RUNTIME_GID=
EVOBOT_INTERNAL_WATCHER_PID=

evobot_permission_error() {
  printf 'evobot: %s\n' "$1" >&2
}

evobot_permission_fatal() {
  evobot_permission_error "$1"
  return 1
}

evobot_valid_nonroot_id() {
  local value="$1"
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null && [ "$value" -le 2147483647 ] 2>/dev/null
}

evobot_write_runtime_ids() {
  local runtime_user="$1"
  local runtime_uid="$2"
  local runtime_gid="$3"
  local passwd_file=/etc/passwd
  local temporary

  temporary=$(mktemp /etc/evobot-passwd.XXXXXX) || return 1
  if ! awk -F: -v OFS=: -v user="$runtime_user" \
    -v uid="$runtime_uid" -v gid="$runtime_gid" '
      $1 == user { $3 = uid; $4 = gid; found = 1 }
      { print }
      END { if (!found) exit 42 }
    ' "$passwd_file" > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0644 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$passwd_file"
}

evobot_configure_node_identity() {
  local runtime_user=node
  local mode="${EVOBOT_HOST_IDENTITY_MODE:-unknown}"
  local requested_uid="${EVOBOT_HOST_UID:-}"
  local requested_gid="${EVOBOT_HOST_GID:-}"
  local current_uid current_gid existing_name target_gid

  current_uid=$(id -u "$runtime_user") || return 1
  current_gid=$(id -g "$runtime_user") || return 1
  case "$mode" in
    direct)
      if ! evobot_valid_nonroot_id "$requested_uid"; then
        evobot_permission_fatal \
          "direct identity mode requires a validated non-root host uid"
        return 1
      fi
      target_gid="$current_gid"
      if [ -n "$requested_gid" ]; then
        if ! evobot_valid_nonroot_id "$requested_gid"; then
          evobot_permission_fatal \
            "direct identity mode received an invalid host gid"
          return 1
        fi
        target_gid="$requested_gid"
      fi
      if [ "$requested_uid" != "$current_uid" ]; then
        existing_name=$(getent passwd "$requested_uid" | cut -d: -f1 || true)
        if [ -n "$existing_name" ]; then
          evobot_permission_fatal \
            "host uid $requested_uid collides with image account $existing_name"
          return 1
        fi
      fi
      if [ "$target_gid" != "$current_gid" ]; then
        existing_name=$(getent group "$target_gid" | cut -d: -f1 || true)
        if [ -n "$existing_name" ]; then
          evobot_permission_error \
            "host gid $target_gid collides with image group $existing_name; keeping node gid $current_gid"
          target_gid="$current_gid"
        elif ! groupmod --gid "$target_gid" "$runtime_user"; then
          evobot_permission_fatal \
            "could not align the node group with host gid $target_gid"
          return 1
        fi
      fi
      if [ "$requested_uid" != "$current_uid" ] || [ "$target_gid" != "$current_gid" ]; then
        if ! evobot_write_runtime_ids "$runtime_user" "$requested_uid" "$target_gid"; then
          evobot_permission_fatal "could not update the node passwd identity"
          return 1
        fi
      fi
      EVOBOT_INTERNAL_IDENTITY_MODE=direct
      EVOBOT_INTERNAL_RUNTIME_UID="$requested_uid"
      EVOBOT_INTERNAL_RUNTIME_GID="$target_gid"
      chown "$requested_uid:$target_gid" /home/node
      ;;
    rootless)
      # Rootless Docker maps container uid 0 to the daemon/service uid. The
      # mapping is verified against host-created bind roots before it is used.
      EVOBOT_INTERNAL_IDENTITY_MODE=rootless
      EVOBOT_INTERNAL_RUNTIME_UID="$current_uid"
      EVOBOT_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    host-root)
      # Host uid 0 can read node-owned 0600 files. Keep the agent non-root and
      # normalize only explicitly authorized writable mounts.
      EVOBOT_INTERNAL_IDENTITY_MODE=host-root
      EVOBOT_INTERNAL_RUNTIME_UID="$current_uid"
      EVOBOT_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    virtualized)
      # Preserve Docker Desktop's established node-owned bind semantics, but
      # never grant group/other access. Real Mac/Windows smoke is required.
      EVOBOT_INTERNAL_IDENTITY_MODE=virtualized
      EVOBOT_INTERNAL_RUNTIME_UID="$current_uid"
      EVOBOT_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    userns)
      evobot_permission_fatal \
        "rootful userns-remap has no safe host/session identity bridge; refusing to start"
      return 1
      ;;
    unknown | *)
      evobot_permission_fatal \
        "container identity could not be determined safely; refusing to start"
      return 1
      ;;
  esac
  export EVOBOT_INTERNAL_IDENTITY_MODE
  export EVOBOT_INTERNAL_RUNTIME_UID EVOBOT_INTERNAL_RUNTIME_GID
}

evobot_prepare_mounted_paths() {
  case "$EVOBOT_INTERNAL_IDENTITY_MODE" in
    direct)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        --normalize-direct-mount-roots
      ;;
    rootless)
      # The watcher performs one owner/group/mode transaction before node runs.
      ;;
    host-root)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        --normalize-node-owned-mounts
      ;;
    virtualized)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        --normalize-node-owned-mounts --native-watch
      ;;
    *)
      evobot_permission_fatal "mount preparation attempted before safe identity setup"
      return 1
      ;;
  esac
}

evobot_prepare_generated_path() {
  local generated_key="$1"
  case "$generated_key" in
    npm-global | skills | dist | chromium) ;;
    *)
      evobot_permission_fatal "unknown generated permission root"
      return 1
      ;;
  esac
  case "$EVOBOT_INTERNAL_IDENTITY_MODE" in
    direct | host-root | virtualized)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        "--normalize-generated=$generated_key"
      ;;
    rootless)
      case "$generated_key" in
        dist | chromium)
          /usr/local/bin/node /app/session-permissions-watcher.mjs \
            "--normalize-generated=$generated_key"
          ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# These locals intentionally shadow persisted root-control variables.
# shellcheck disable=SC2034
evobot_source_runtime_env() {
  # Shadow every root-control variable while sourcing the host-generated env.
  # Ordinary runtime variables intentionally persist as globals.
  local EVOBOT_HOST_IDENTITY_MODE="$EVOBOT_HOST_IDENTITY_MODE"
  local EVOBOT_HOST_UID="${EVOBOT_HOST_UID:-}"
  local EVOBOT_HOST_GID="${EVOBOT_HOST_GID:-}"
  local EVOBOT_RECONCILE_SESSION_PERMISSIONS=
  local EVOBOT_MOUNT_PREPARE_MODE=
  local EVOBOT_RUNTIME_USER=
  local EVOBOT_SESSION_ROOT=
  local EVOBOT_SESSION_PERMISSION_HELPER=
  local EVOBOT_SESSION_PERMISSION_INTERVAL=
  local EVOBOT_SESSION_PERMISSION_PID=
  local EVOBOT_INTERNAL_IDENTITY_MODE="$EVOBOT_INTERNAL_IDENTITY_MODE"
  local EVOBOT_INTERNAL_RUNTIME_UID="$EVOBOT_INTERNAL_RUNTIME_UID"
  local EVOBOT_INTERNAL_RUNTIME_GID="$EVOBOT_INTERNAL_RUNTIME_GID"
  local EVOBOT_INTERNAL_WATCHER_PID="$EVOBOT_INTERNAL_WATCHER_PID"
  if [ -f /workspace/env-dir/env ]; then
    # Some host encryption products expose an envelope to the Linux VM rather
    # than plaintext. Never source ciphertext as a root shell script.
    if [ "$(LC_ALL=C head -c 16 /workspace/env-dir/env)" = '%TSD-Header-###%' ]; then
      printf '%s\n' 'evobot: runtime env bind contains a host-encrypted file; make plaintext available to the Docker daemon' >&2
      return 1
    fi
    set -a
    # Fixed read-only bind generated by the host.
    # shellcheck disable=SC1091
    source /workspace/env-dir/env
    set +a
  fi
}

evobot_migrate_direct_managed_paths() {
  [ "$EVOBOT_INTERNAL_IDENTITY_MODE" = direct ] || return 0
  # The fixed-root descriptor walker changes only legacy uid 1000 ownership.
  # It intentionally rescans on every start: an agent-forgeable completion
  # marker could otherwise preserve unsafe modes after an image rollback.
  /usr/local/bin/node /app/session-permissions-watcher.mjs --migrate-direct
}

evobot_verify_rootless_bridge() {
  local mounted_path current_uid legacy_uid
  [ "$EVOBOT_INTERNAL_IDENTITY_MODE" = rootless ] || return 0
  legacy_uid="$EVOBOT_INTERNAL_RUNTIME_UID"
  for mounted_path in \
    /home/node/.claude /home/node/.feishu-cli \
    /workspace/group /workspace/ipc /workspace/extra; do
    [ -e "$mounted_path" ] || continue
    current_uid=$(stat -c %u "$mounted_path") || return 1
    if [ "$current_uid" != 0 ] && [ "$current_uid" != "$legacy_uid" ]; then
      evobot_permission_fatal \
        "rootless bind root $mounted_path has unexpected uid $current_uid (allowed: 0 or legacy node uid $legacy_uid)"
      return 1
    fi
  done
}

evobot_start_session_permission_watcher() {
  local attempt watcher_mode
  case "$EVOBOT_INTERNAL_IDENTITY_MODE" in
    rootless) watcher_mode= ;;
    host-root) watcher_mode=--watch-node-owned-mounts ;;
    virtualized) watcher_mode='--watch-node-owned-mounts --native-watch' ;;
    *) return 0 ;;
  esac
  evobot_verify_rootless_bridge || return 1
  rm -f -- /run/evobot-session-watcher.ready /run/evobot-session-watcher.failed
  /usr/local/bin/node /app/session-permissions-watcher.mjs $watcher_mode &
  EVOBOT_INTERNAL_WATCHER_PID=$!
  for ((attempt = 0; attempt < 500; attempt++)); do
    # A watcher can fail immediately after writing readiness. A failure marker
    # or dead process always wins over a stale ready marker.
    if [ -e /run/evobot-session-watcher.failed ] || \
      ! kill -0 "$EVOBOT_INTERNAL_WATCHER_PID" 2>/dev/null; then
      wait "$EVOBOT_INTERNAL_WATCHER_PID" 2>/dev/null || true
      EVOBOT_INTERNAL_WATCHER_PID=
      if [ -s /run/evobot-session-watcher.failed ]; then
        cat -- /run/evobot-session-watcher.failed >&2 || true
      fi
      evobot_permission_fatal \
        "$EVOBOT_INTERNAL_IDENTITY_MODE permission watcher failed before readiness"
      return 1
    fi
    if [ -e /run/evobot-session-watcher.ready ]; then
      export EVOBOT_INTERNAL_WATCHER_PID
      return 0
    fi
    sleep 0.02
  done
  kill "$EVOBOT_INTERNAL_WATCHER_PID" 2>/dev/null || true
  wait "$EVOBOT_INTERNAL_WATCHER_PID" 2>/dev/null || true
  EVOBOT_INTERNAL_WATCHER_PID=
  evobot_permission_fatal \
    "$EVOBOT_INTERNAL_IDENTITY_MODE permission watcher readiness timed out"
  return 1
}

# Root-only ownership normalization can report success while the runtime user
# is still denied: a virtualized bind can keep the host-mapped owner even after
# chown, and the agent then fails later with an opaque EACCES. Re-run the check
# as node so the exact path, mode and identity mode are attributed here.
evobot_verify_runtime_access() {
  local report status=0
  report=$(setpriv --reuid=node --regid=node --init-groups -- \
    /usr/local/bin/node /app/session-runtime-access.mjs 2>&1) || status=$?
  if [ -n "$report" ]; then
    printf '%s\n' "$report" >&2
  fi
  if [ "$status" -ne 0 ]; then
    evobot_permission_error \
      "runtime access verification failed for identity mode $EVOBOT_INTERNAL_IDENTITY_MODE"
    return 1
  fi
  return 0
}

evobot_stop_session_permission_watcher() {
  local watcher_status=0
  if [ -n "$EVOBOT_INTERNAL_WATCHER_PID" ]; then
    kill "$EVOBOT_INTERNAL_WATCHER_PID" 2>/dev/null || true
    wait "$EVOBOT_INTERNAL_WATCHER_PID" 2>/dev/null || watcher_status=$?
    EVOBOT_INTERNAL_WATCHER_PID=
  fi
  if [ "$watcher_status" -ne 0 ]; then
    evobot_permission_fatal "permission watcher final scan failed"
    return 1
  fi
  case "$EVOBOT_INTERNAL_IDENTITY_MODE" in
    direct)
      /usr/local/bin/node /app/session-permissions-watcher.mjs --migrate-direct
      ;;
    rootless)
      /usr/local/bin/node /app/session-permissions-watcher.mjs --once
      ;;
  esac
}
