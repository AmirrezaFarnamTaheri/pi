#!/usr/bin/env bash
# Install a standalone Pi release archive without using upstream npm or pi.dev.
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$source_dir/pi" ]]; then
  echo "The release archive is missing its pi executable" >&2
  exit 1
fi

install_dir="${PI_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pi}"
bin_dir="${PI_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir" "$bin_dir"
install_dir="$(cd "$install_dir" && pwd)"
bin_dir="$(cd "$bin_dir" && pwd)"
if [[ "$source_dir" == "$install_dir" ]]; then
  echo "Choose an installation directory separate from the extracted archive" >&2
  exit 1
fi
if [[ -e "$bin_dir/pi" && ! -L "$bin_dir/pi" ]]; then
  echo "Refusing to overwrite a non-symlink at $bin_dir/pi" >&2
  exit 1
fi

cp -R "$source_dir/." "$install_dir/"
chmod +x "$install_dir/pi"
ln -sfn "$install_dir/pi" "$bin_dir/pi"
printf 'Installed Pi at %s\nRun %s --version\n' "$install_dir" "$bin_dir/pi"
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
  printf 'Add %s to PATH to run pi from any directory.\n' "$bin_dir"
fi
