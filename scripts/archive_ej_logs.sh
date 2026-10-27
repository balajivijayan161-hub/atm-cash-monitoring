#!/usr/bin/env bash
# Archive daily ATM electronic journal (EJ) logs.
# Compress each journal by its date, move it under the archive directory,
# purge day folders older than the retention window, and write a log.
#
# Usage:
#   scripts/archive_ej_logs.sh --source ./ej_logs --archive ./ej_archive --retain-days 90
set -euo pipefail

SOURCE_DIR="./ej_logs"
ARCHIVE_DIR="./ej_archive"
RETAIN_DAYS=90
LOG_FILE=""

usage() {
  cat <<'EOF'
Usage: archive_ej_logs.sh [--source DIR] [--archive DIR] [--retain-days N] [--log FILE]

Compress .log, .ej, and .jrn files from the source tree. The journal date is
taken from YYYY-MM-DD or YYYYMMDD in the filename, otherwise from the file's
modification time. Archives land in ARCHIVE/YYYY-MM-DD/<relative path>.gz.
Day folders strictly older than the retention window are removed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --archive) ARCHIVE_DIR="${2:-}"; shift 2 ;;
    --retain-days) RETAIN_DAYS="${2:-}"; shift 2 ;;
    --log) LOG_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]]; then
  echo "retain-days must be a whole number" >&2
  exit 2
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Source directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$ARCHIVE_DIR"
if [[ -z "$LOG_FILE" ]]; then
  LOG_FILE="$ARCHIVE_DIR/archive.log"
fi
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line" | tee -a "$LOG_FILE"
}

file_date() {
  local base compact
  base="$(basename "$1")"
  if [[ $base =~ ([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return
  fi
  if [[ $base =~ ([0-9]{8}) ]]; then
    compact="${BASH_REMATCH[1]}"
    printf '%s\n' "${compact:0:4}-${compact:4:2}-${compact:6:2}"
    return
  fi
  date -r "$1" +%F
}

archived=0
while IFS= read -r -d '' file; do
  journal_date="$(file_date "$file")"
  if ! [[ $journal_date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    log "SKIP $file (no journal date)"
    continue
  fi
  rel="${file#"$SOURCE_DIR"/}"
  dest_dir="$ARCHIVE_DIR/$journal_date/$(dirname "$rel")"
  mkdir -p "$dest_dir"
  base="$(basename "$file")"
  if [[ "$file" == *.gz ]]; then
    mv -- "$file" "$dest_dir/$base"
    log "MOVE $file -> $dest_dir/$base"
  else
    gzip -c -n -- "$file" > "$dest_dir/$base.gz"
    rm -f -- "$file"
    log "ARCHIVE $file -> $dest_dir/$base.gz"
  fi
  archived=$((archived + 1))
done < <(find "$SOURCE_DIR" -type f \( -name '*.log' -o -name '*.ej' -o -name '*.jrn' -o -name '*.log.gz' -o -name '*.ej.gz' \) -print0)

cutoff="$(date -d "-${RETAIN_DAYS} days" +%F)"
purged=0
while IFS= read -r -d '' daydir; do
  day="$(basename "$daydir")"
  if [[ $day =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ "$day" < "$cutoff" ]]; then
    rm -rf -- "$daydir"
    log "PURGE $daydir"
    purged=$((purged + 1))
  fi
done < <(find "$ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -type d -print0)

find "$SOURCE_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null || true

log "DONE archived=$archived purged_days=$purged retain_days=$RETAIN_DAYS cutoff=$cutoff"
