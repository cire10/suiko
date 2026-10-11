#!/bin/sh
# SpecReview one-step installer (POSIX sh).
#
#   From a checkout:  ./install.sh [--yes] [specreview install options, e.g. --only claude,codex]
#   Without one:      curl -fsSL <raw URL of this file> | SPECREVIEW_REPO=<git URL> sh -s -- [--yes] [options]
#
# 1. checks Node.js >= 20.19 (and npm);
# 2. uses this checkout, or clones SPECREVIEW_REPO into ~/.specreview/app (updates it when it is already there);
# 3. installs the npm dependencies (a checkout that already has node_modules is left as is);
# 4. puts `specreview` on PATH with `npm link`, or, when that fails (a global prefix that needs sudo), with a small
#    shim in ~/.local/bin;
# 5. runs `specreview install`, which detects your coding agents and prints exactly what it would write for each.
#    Nothing is written to an agent's config until you re-run with --yes (= `specreview install --apply`).
#
# Environment:
#   SPECREVIEW_REPO      git URL to clone when not run from a checkout (there is no public default)
#   SPECREVIEW_REF       branch or tag to check out (default: the repository's default branch; a later run without it
#                        moves the clone back to the default branch)
#   SPECREVIEW_APP_DIR   where to clone (default: $HOME/.specreview/app)
#   SPECREVIEW_BIN_DIR   where the fallback shim goes (default: $HOME/.local/bin)
#   SPECREVIEW_NO_LINK=1 skip `npm link` and always use the shim
# Undo: `specreview uninstall --apply` removes what `specreview install` added; then `npm unlink -g specreview` (or
# delete the shim) and the clone.

set -eu

say() { printf '%s\n' "$*"; }
warn() { printf 'install.sh: %s\n' "$*" >&2; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [--yes] [specreview install options]
       curl -fsSL <URL>/install.sh | SPECREVIEW_REPO=<git URL> sh -s -- [--yes] [options]

Installs the SpecReview CLI, then runs `specreview install` (a dry run that lists, per detected coding agent, the
files and entries it would write). --yes applies them (`specreview install --apply`).
Other options go to `specreview install`: --only a,b  --skip a,b  --project  --json
Environment: SPECREVIEW_REPO, SPECREVIEW_REF, SPECREVIEW_APP_DIR, SPECREVIEW_BIN_DIR, SPECREVIEW_NO_LINK=1
EOF
}

# Single-quote a string for a shell script.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

APPLY=0
FORWARD=''
for arg in "$@"; do
  case "$arg" in
    -y | --yes | --apply) APPLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) FORWARD="$FORWARD $(quote "$arg")" ;;
  esac
done

[ -n "${HOME:-}" ] || die 'HOME is not set'

# 1. Node.js >= 20.19 -------------------------------------------------------------------------------------------
NODE=$(command -v node 2>/dev/null || true)
[ -n "$NODE" ] || die 'Node.js 20.19 or newer is required and node is not on PATH (https://nodejs.org)'
NODE_VERSION=$("$NODE" -p 'process.versions.node' 2>/dev/null || true)
MAJOR=${NODE_VERSION%%.*}
REST=${NODE_VERSION#*.}
MINOR=${REST%%.*}
case "$MAJOR.$MINOR" in
  *[!0-9.]* | .* | *.) die "could not read the Node.js version from $NODE (got: ${NODE_VERSION:-nothing})" ;;
esac
if [ "$MAJOR" -lt 20 ] || { [ "$MAJOR" -eq 20 ] && [ "$MINOR" -lt 19 ]; }; then
  die "Node.js 20.19 or newer is required; $NODE is $NODE_VERSION"
fi
NPM=$(command -v npm 2>/dev/null || true)

# 2. The SpecReview source: this checkout, or a clone of SPECREVIEW_REPO ----------------------------------------
is_specreview() {
  [ -f "$1/bin/specreview.js" ] && [ -f "$1/package.json" ] && grep -q '"name": *"specreview"' "$1/package.json"
}

SRC=''
case "$0" in
  */*) HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || true) ;;
  *) HERE=$(if [ -f "$0" ]; then pwd -P; fi) ;;
esac
if [ -n "$HERE" ] && [ -f "$HERE/install.sh" ] && is_specreview "$HERE"; then
  SRC=$HERE
  MODE=checkout
  say "SpecReview checkout: $SRC"
else
  MODE=clone
  REPO=${SPECREVIEW_REPO:-}
  [ -n "$REPO" ] || die 'not run from a SpecReview checkout, and SPECREVIEW_REPO is not set. SpecReview has no public
download: set SPECREVIEW_REPO to the git URL of the repository you were given, e.g.
  curl -fsSL <URL>/install.sh | SPECREVIEW_REPO=git@github.com:<owner>/specreview.git sh
or clone it yourself and run ./install.sh from the clone.'
  command -v git >/dev/null 2>&1 || die 'git is required to fetch SpecReview'
  SRC=${SPECREVIEW_APP_DIR:-$HOME/.specreview/app}
  REF=${SPECREVIEW_REF:-}
  if [ -d "$SRC/.git" ]; then
    ORIGIN=$(git -C "$SRC" config --get remote.origin.url 2>/dev/null || true)
    [ "$ORIGIN" = "$REPO" ] || die "$SRC is a clone of ${ORIGIN:-another repository}, not $REPO; move it away or set SPECREVIEW_APP_DIR"
    say "Updating $SRC"
    if [ -n "$REF" ]; then
      git -C "$SRC" fetch --quiet origin "$REF" || die "git fetch of $REF failed in $SRC"
      git -C "$SRC" checkout --quiet --detach FETCH_HEAD || die "could not check out $REF in $SRC"
    elif git -C "$SRC" symbolic-ref -q HEAD >/dev/null 2>&1; then
      git -C "$SRC" pull --quiet --ff-only || die "git pull --ff-only failed in $SRC (local changes?); fix it or delete $SRC and re-run"
    else
      # Detached (an earlier run pinned SPECREVIEW_REF): `git pull` would do nothing, so go to the default branch.
      say "  (the clone was pinned to a tag or commit; moving it to the repository's default branch)"
      git -C "$SRC" fetch --quiet origin HEAD || die "git fetch of the default branch failed in $SRC"
      git -C "$SRC" checkout --quiet --detach FETCH_HEAD || die "could not check out the default branch in $SRC (local changes?); fix it or delete $SRC and re-run"
    fi
  elif [ -e "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null)" ]; then
    die "$SRC exists and is not a SpecReview clone; move it away or set SPECREVIEW_APP_DIR"
  else
    say "Cloning $REPO into $SRC"
    mkdir -p "$(dirname "$SRC")"
    if [ -n "$REF" ]; then
      git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC" || die "git clone of $REPO ($REF) failed"
    else
      git clone --quiet --depth 1 "$REPO" "$SRC" || die "git clone of $REPO failed"
    fi
  fi
  is_specreview "$SRC" || die "$SRC does not look like SpecReview (no bin/specreview.js or package.json named specreview)"
fi

# 3. npm dependencies -------------------------------------------------------------------------------------------
npm_quiet() {
  # npm_quiet <log> <args...>: run npm in $SRC, output to <log>
  log=$1
  shift
  (cd "$SRC" && "$NPM" "$@") >"$log" 2>&1
}

LOG=$(mktemp "${TMPDIR:-/tmp}/specreview-install.XXXXXX")
trap 'rm -f "$LOG"' EXIT
trap 'exit 130' HUP INT TERM

if [ "$MODE" = checkout ] && [ -e "$SRC/node_modules" ]; then
  say 'Dependencies: node_modules already present (run "npm ci" yourself to refresh them)'
else
  [ -n "$NPM" ] || die 'npm is required to install the dependencies (it comes with Node.js)'
  if [ "$MODE" = clone ]; then
    set -- ci --omit=dev --no-audit --no-fund
  else
    set -- ci --no-audit --no-fund
  fi
  say "Installing dependencies (npm $1)"
  if ! npm_quiet "$LOG" "$@"; then
    shift
    warn "npm ci failed; trying npm install"
    npm_quiet "$LOG" install "$@" || {
      tail -n 20 "$LOG" >&2
      die "npm install failed in $SRC"
    }
  fi
fi

# 4. `specreview` on PATH ---------------------------------------------------------------------------------------
BIN_DIR=${SPECREVIEW_BIN_DIR:-$HOME/.local/bin}
SHIM="$BIN_DIR/specreview"
SHIM_TAG='specreview-shim'

write_shim() {
  if [ -e "$SHIM" ] && ! grep -q "$SHIM_TAG" "$SHIM" 2>/dev/null; then
    die "$SHIM exists and was not written by this installer; remove it or set SPECREVIEW_BIN_DIR"
  fi
  mkdir -p "$BIN_DIR"
  node_q=$(quote "$NODE")
  script_q=$(quote "$SRC/bin/specreview.js")
  cat >"$SHIM.tmp" <<EOF
#!/bin/sh
# $SHIM_TAG: written by SpecReview's install.sh; runs the CLI from $SRC
if [ -x $node_q ]; then exec $node_q $script_q "\$@"; fi
exec node $script_q "\$@"
EOF
  chmod 755 "$SHIM.tmp"
  mv "$SHIM.tmp" "$SHIM"
  say "Wrote $SHIM"
}

# The real path of a file (symlinks resolved), or nothing.
realpath_of() {
  "$NODE" -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])) } catch {}' "$1" 2>/dev/null || true
}

LINKED=0
if [ "${SPECREVIEW_NO_LINK:-}" != 1 ] && [ -n "$NPM" ]; then
  if npm_quiet "$LOG" link --no-audit --no-fund; then
    LINKED=1
    say 'Linked specreview with npm link'
  else
    say 'npm link failed (the global npm prefix probably needs sudo); using a shim instead'
  fi
fi
FOUND=$(command -v specreview 2>/dev/null || true)
# npm's link can live at the shim's own path (npm prefix ~/.local, so its bin is ~/.local/bin): that is npm's link
# to this checkout, not a file to replace.
NPM_LINK_AT_SHIM=0
if [ "$LINKED" = 1 ] && [ -n "$FOUND" ] && [ "$FOUND" = "$SHIM" ] && [ "$(realpath_of "$FOUND")" = "$(realpath_of "$SRC/bin/specreview.js")" ]; then
  NPM_LINK_AT_SHIM=1
fi
if [ "$NPM_LINK_AT_SHIM" = 0 ] && { [ "$LINKED" = 0 ] || [ -z "$FOUND" ] || [ "$FOUND" = "$SHIM" ]; }; then
  if [ "$LINKED" = 1 ] && [ -z "$FOUND" ]; then say "npm linked specreview into a directory that is not on PATH; adding a shim in $BIN_DIR"; fi
  write_shim
  # PATH is left as is for step 5: while BIN_DIR is not on it, `specreview install` writes the absolute invocation
  # into the agents' instructions, which works from any shell.
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on PATH. Add it (e.g. in ~/.profile), then re-run \"specreview install --apply\" to use the short command:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
fi

# 5. Configure the coding agents --------------------------------------------------------------------------------
say ''
if [ "$APPLY" = 1 ]; then
  FORWARD="$FORWARD --apply"
fi
STATUS=0
eval "set -- $FORWARD"
# SPECREVIEW_NODE: the node found on PATH (e.g. /opt/homebrew/bin/node), which the agent configs get instead of its
# resolved, version-specific path.
SPECREVIEW_NODE=$NODE "$NODE" "$SRC/bin/specreview.js" install "$@" || STATUS=$?
case "$FORWARD" in *"'--json'"*) exit "$STATUS" ;; esac
if [ "$APPLY" = 0 ] && [ "$STATUS" -eq 0 ]; then
  RUN=specreview
  if ! command -v specreview >/dev/null 2>&1 && [ -x "$SHIM" ]; then RUN=$(quote "$SHIM"); fi
  say ''
  if [ "$MODE" = checkout ]; then
    say "To write these changes: $RUN install --apply   (or: $(quote "$SRC/install.sh") --yes)"
  else
    say "To write these changes: $RUN install --apply"
  fi
fi
exit "$STATUS"
