#!/usr/bin/env bash
#
# Tabularis one-shot launcher.
#
# Usage:
#   ./start.sh                 Desktop app (compiles Rust, starts Vite, opens the window)
#   ./start.sh ui              Frontend dev server only (http://localhost:5173)
#   ./start.sh web [args]      Build the frontend, then serve `tabularis web`
#   ./start.sh --check         Environment self-check (node / pnpm / cargo / perl)
#   ./start.sh --help          Show help
#
# Arguments after a mode are forwarded to the underlying command, e.g.:
#   ./start.sh web --port 8081
#   ./start.sh ui --port 5174
#   ./start.sh -- --no-watch
#
# Dependencies are installed automatically on first run. A missing node, pnpm,
# cargo or (on Windows) native Perl stops the script with an actionable message.

set -euo pipefail

cd "$(dirname "$0")"

if [ -t 1 ]; then
    INFO=$'\033[36m'
    WARN=$'\033[33m'
    ERR=$'\033[31m'
    RESET=$'\033[0m'
else
    INFO=''
    WARN=''
    ERR=''
    RESET=''
fi

info() { printf '%s%s%s\n' "$INFO" "$1" "$RESET"; }
warn() { printf '%s%s%s\n' "$WARN" "$1" "$RESET" >&2; }
fail() {
    printf '%sError: %s%s\n' "$ERR" "$1" "$RESET" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Tabularis one-shot launcher

Usage:
  ./start.sh                 Start the desktop app (default, most capabilities)
  ./start.sh desktop         Same as the default
  ./start.sh ui              Start only the frontend dev server, no Rust build
  ./start.sh web [args]      Build the frontend and start the web server
  ./start.sh --check         Print an environment self-check and exit
  ./start.sh -h | --help     Show this help

Forwarding examples:
  ./start.sh web --port 8081
  ./start.sh ui --port 5174
  ./start.sh -- --no-watch

Notes:
  desktop and web need Rust stable; ui needs only Node.js and pnpm.
  On Windows, desktop and web also need a native Windows Perl (see below).
  Native Tauri capabilities (file dialogs, notifications, plugins, IPC) are
  unavailable in ui mode.
  See the Development section of README.md and docs/web/ for details.

Perl on Windows:
  The openssl crate in src-tauri enables the `vendored` feature, so building it
  runs the OpenSSL Configure script through Perl. OpenSSL rejects MSYS2/Cygwin
  Perl (which is what Git for Windows ships at /usr/bin/perl), so a native
  Windows Perl is required:
      winget install --id StrawberryPerl.StrawberryPerl -e
  This script probes the usual install locations (Strawberry Perl, C:\Perl64,
  C:\Perl) and exports PERL itself, so PATH order does not need adjusting even
  though Git Bash's /usr/bin usually shadows the native installation.
EOF
}

find_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        printf 'pnpm'
        return 0
    fi
    if command -v pnpm.cmd >/dev/null 2>&1; then
        printf 'pnpm.cmd'
        return 0
    fi
    if command -v corepack >/dev/null 2>&1; then
        warn 'pnpm not found, trying to enable it through corepack…'
        corepack enable pnpm >/dev/null 2>&1 || true
        if command -v pnpm >/dev/null 2>&1; then
            printf 'pnpm'
            return 0
        fi
        if command -v pnpm.cmd >/dev/null 2>&1; then
            printf 'pnpm.cmd'
            return 0
        fi
    fi
    return 1
}

require_node() {
    command -v node >/dev/null 2>&1 ||
        fail 'Node.js not found. Install the version pinned in .node-version and retry.'
}

require_cargo() {
    command -v cargo >/dev/null 2>&1 ||
        fail 'cargo not found. This mode needs Rust stable; install it from https://rustup.rs and retry.'
}

# src-tauri's openssl crate is built from source, which runs OpenSSL's Configure
# through Perl. OpenSSL's Configure rejects MSYS2/Cygwin Perl (Git for Windows
# ships one at /usr/bin/perl) with:
#   This perl implementation doesn't produce Windows like paths ...
# so probe for a native Windows Perl and export PERL for openssl-src.
PERL_CANDIDATES="
/c/Strawberry/perl/bin/perl.exe
/c/Strawberry/perl/bin/perl
/c/Perl64/bin/perl.exe
/c/Perl/bin/perl.exe
"

perl_is_windows_native() {
    # MSVC targets need a MSWin32 Perl; $^O reports the platform it was built for.
    [ -x "$1" ] || return 1
    "$1" -e 'exit($^O eq "MSWin32" ? 0 : 1)' >/dev/null 2>&1
}

ensure_windows_perl() {
    case "$(uname -s 2>/dev/null)" in
        MINGW* | MSYS* | CYGWIN*) ;;
        *) return 0 ;; # Not Windows: leave the environment alone.
    esac

    if [ -n "${PERL:-}" ] && perl_is_windows_native "$PERL"; then
        info "Using the PERL already set: $PERL"
        return 0
    fi

    for candidate in $PERL_CANDIDATES; do
        if perl_is_windows_native "$candidate"; then
            PERL="$candidate"
            export PERL
            info "Using native Windows Perl: $PERL"
            return 0
        fi
    done

    # No native Perl found: report precisely what is on PATH when it is the
    # MSYS2 build, so the message points at the real cause.
    if command -v perl >/dev/null 2>&1; then
        if perl_is_windows_native "$(command -v perl)"; then
            info "The perl on PATH is already native: $(command -v perl)"
            return 0
        fi
        fail "$(command -v perl) is an MSYS2/Cygwin Perl and cannot build OpenSSL.
Install a native Windows Perl and retry:
    winget install --id StrawberryPerl.StrawberryPerl -e
Or point the script at one explicitly: PERL=\"C:/Strawberry/perl/bin/perl.exe\" ./start.sh"
    fi

    fail 'Perl not found. Building the Rust backend needs Perl to build OpenSSL:
    winget install --id StrawberryPerl.StrawberryPerl -e'
}

describe_perl() {
    if [ -n "${PERL:-}" ]; then
        printf 'PERL=%s (%s)' "$PERL" "$("$PERL" -e 'print $^O' 2>/dev/null || echo '?')"
    elif command -v perl >/dev/null 2>&1; then
        printf 'perl=%s (%s)' "$(command -v perl)" "$(perl -e 'print $^O' 2>/dev/null || echo '?')"
    else
        printf 'perl=<not found>'
    fi
}

MODE='desktop'
if [ $# -gt 0 ]; then
    case "$1" in
        -h | --help | help)
            usage
            exit 0
            ;;
        --check | check)
            MODE='check'
            shift
            ;;
        desktop | app | tauri)
            MODE='desktop'
            shift
            ;;
        ui | dev | frontend)
            MODE='ui'
            shift
            ;;
        web)
            MODE='web'
            shift
            ;;
        -*)
            # No mode given but flags present: desktop is the default.
            ;;
        *)
            printf '%sError: unknown mode "%s"%s\n\n' "$ERR" "$1" "$RESET" >&2
            usage >&2
            exit 1
            ;;
    esac
fi

case "$MODE" in
    desktop | web)
        require_node
        require_cargo
        ensure_windows_perl
        ;;
    ui) require_node ;;
    check)
        info 'Environment self-check'
        printf '  node     : %s\n' "$(node --version 2>/dev/null || echo '<not found>')"
        PNPM_PATH="$(
            command -v pnpm 2>/dev/null || command -v pnpm.cmd 2>/dev/null || echo '<not found>'
        )"
        printf '  pnpm     : %s\n' "$PNPM_PATH"
        printf '  cargo    : %s\n' "$(cargo --version 2>/dev/null || echo '<not found>')"
        printf '  platform : %s\n' "$(uname -s 2>/dev/null || echo '?')"
        case "$(uname -s 2>/dev/null)" in
            MINGW* | MSYS* | CYGWIN*)
                printf '  perl before: %s\n' "$(describe_perl)"
                ensure_windows_perl
                printf '  perl after : %s\n' "$(describe_perl)"
                ;;
            *) printf '  perl     : %s\n' "$(describe_perl)" ;;
        esac
        if [ -d packages/web-ui/dist ]; then
            printf '  dist     : packages/web-ui/dist present\n'
        else
            printf '  dist     : missing, built automatically before a desktop build\n'
        fi
        if [ -d node_modules ]; then
            printf '  deps     : node_modules present\n'
        else
            printf '  deps     : not installed, pnpm install runs on start\n'
        fi
        exit 0
        ;;
esac

PNPM="$(find_pnpm)" || fail 'pnpm not found. Run `corepack enable pnpm`, or `npm install -g pnpm@10.30.3`, then retry.'

if [ ! -d node_modules ] || { [ -f pnpm-lock.yaml ] && [ pnpm-lock.yaml -nt node_modules ]; }; then
    info 'Installing / updating dependencies (pnpm install)…'
    "$PNPM" install
fi

# tauri.conf.json maps ../packages/web-ui/dist/ as a resource and tauri-build
# validates it at compile time, failing with
#   resource path `..\packages\web-ui\dist` doesn't exist
# so a desktop build needs the frontend built once first.
if [ "$MODE" = 'desktop' ] && [ ! -d packages/web-ui/dist ]; then
    info 'packages/web-ui/dist is missing, building the frontend first (tauri-build needs it)…'
    "$PNPM" build
fi

case "$MODE" in
    desktop)
        info 'Starting the desktop app; the first Rust compile takes a few minutes…'
        if [ $# -gt 0 ]; then
            exec "$PNPM" tauri dev "$@"
        else
            exec "$PNPM" tauri dev
        fi
        ;;
    ui)
        info 'Starting the frontend dev server (no native Tauri capabilities)…'
        if [ $# -gt 0 ]; then
            exec "$PNPM" dev "$@"
        else
            exec "$PNPM" dev
        fi
        ;;
    web)
        info 'Building the frontend and starting the web server…'
        if [ $# -gt 0 ]; then
            exec "$PNPM" dev:web -- "$@"
        else
            exec "$PNPM" dev:web
        fi
        ;;
esac
