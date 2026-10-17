#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${ROOT_DIR}/runtime"

log() {
  printf '\n[%s] %s\n' "install-vps" "$1"
}

fail() {
  printf '\n[%s] ERROR: %s\n' "install-vps" "$1" >&2
  exit 1
}

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_ubuntu() {
  if [[ ! -f /etc/os-release ]]; then
    fail "Khong xac dinh duoc he dieu hanh. Script nay danh cho Ubuntu VPS."
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *"ubuntu"* && "${ID_LIKE:-}" != *"debian"* ]]; then
    fail "Script nay toi uu cho Ubuntu/Debian. He hien tai: ${PRETTY_NAME:-unknown}."
  fi
}

ensure_env_file() {
  if [[ ! -f "${ROOT_DIR}/.env" ]]; then
    fail "Chua co file .env trong repo. Hay upload .env truoc khi cai dat."
  fi
}

ensure_runtime_dirs() {
  mkdir -p "${RUNTIME_DIR}"
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi

  log "Dang cai curl..."
  run_as_root apt-get update -y
  run_as_root apt-get install -y curl ca-certificates
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  log "Docker chua duoc cai. Dang cai Docker Engine..."
  ensure_curl
  curl -fsSL https://get.docker.com | run_as_root sh
}

ensure_docker_compose() {
  if run_as_root docker compose version >/dev/null 2>&1; then
    return
  fi

  log "Docker Compose plugin chua co. Dang cai docker-compose-plugin..."
  run_as_root apt-get update -y
  run_as_root apt-get install -y docker-compose-plugin
}

start_docker_service() {
  log "Dang bat docker service..."
  run_as_root systemctl enable --now docker
}

deploy_stack() {
  log "Dang build va khoi dong bot..."
  cd "${ROOT_DIR}"
  run_as_root docker compose config >/dev/null
  run_as_root docker compose up -d --build
}

show_result() {
  log "Trang thai container:"
  run_as_root docker compose ps

  cat <<'EOF'

[install-vps] Cai dat hoan tat.

Lenh su dung:
- Xem log realtime: sudo docker compose logs -f
- Khoi dong lai: sudo docker compose restart
- Cap nhat sau khi sua code/git pull: bash install-vps.sh

Bot dang chay nen va tu khoi dong lai cung VPS.
EOF
}

main() {
  ensure_ubuntu
  ensure_env_file
  ensure_runtime_dirs
  ensure_docker
  ensure_docker_compose
  start_docker_service
  deploy_stack
  show_result
}

main "$@"
