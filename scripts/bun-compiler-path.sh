#!/usr/bin/env bash
# Source from packages/coding-agent: execute Bun with the platform-native outfile.
# Git Bash native bun.exe does not understand an absolute /d/... outfile.
pi_bun_compile() {
    local platform="$1" target="$2" outfile="$3"
    if [[ "$platform" == windows-* ]] && command -v cygpath >/dev/null 2>&1; then
        outfile="$(cygpath -w "$outfile")"
    fi
    bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
        --compile-autoload-package-json --target="$target" \
        ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
        ./src/extensions/codemode/worker.ts --outfile "$outfile"
}

# GitHub's GITHUB_WORKSPACE is D:\\a\\... on Windows; Git Bash must not
# treat this drive-qualified path as a relative output root.
pi_normalize_output_dir() {
    local dir="$1"
    if [[ "$dir" =~ ^[A-Za-z]:[/\\\\] ]]; then
        if ! command -v cygpath >/dev/null 2>&1; then
            echo "Windows output directory requires cygpath: $dir" >&2
            return 1
        fi
        cygpath -u "$dir"
    elif [[ "$dir" == /* ]]; then
        printf '%s\n' "$dir"
    else
        printf '%s/%s\n' "$PWD" "$dir"
    fi
}
