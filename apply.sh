#!/usr/bin/env bash
# Installs trapezoid-tabs.css into a Firefox profile.
#
#   ./apply.sh                 install into the default profile
#   ./apply.sh --list          list profiles (* marks the default)
#   ./apply.sh --profile DIR   install into a specific profile directory
#   ./apply.sh --link          symlink the stylesheet instead of copying it, so
#                              edits in this repo apply on the next restart
#   ./apply.sh --remove        uninstall from the chosen profile
#
# What it does to the profile:
#   chrome/trapezoid-tabs.css   copied (or symlinked) from this repo
#   chrome/userChrome.css       gets an @import line for it; an existing file is
#                               backed up first and otherwise left alone
#   user.js                     toolkit.legacyUserProfileCustomizations.stylesheets
#                               = true, without which Firefox ignores userChrome.css
#
# Set FIREFOX_ROOT to point at a non-standard directory holding profiles.ini.
set -euo pipefail

repo=$(cd "$(dirname "$0")" && pwd)
css_name=trapezoid-tabs.css
import_line="@import url(\"$css_name\");"
pref_name=toolkit.legacyUserProfileCustomizations.stylesheets
pref_line="user_pref(\"$pref_name\", true);"

die() { echo "apply.sh: $*" >&2; exit 1; }

firefox_root() {
  if [[ -n ${FIREFOX_ROOT:-} ]]; then
    echo "$FIREFOX_ROOT"
    return
  fi
  if [[ $(uname -s) == Darwin ]]; then
    echo "$HOME/Library/Application Support/Firefox"
    return
  fi
  local d
  for d in "$HOME/.mozilla/firefox" \
           "${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox" \
           "$HOME/snap/firefox/common/.mozilla/firefox" \
           "$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"; do
    if [[ -f $d/profiles.ini ]]; then
      echo "$d"
      return
    fi
  done
  echo "$HOME/.mozilla/firefox"
}

# Prints one line per profile: <default 0|1><TAB><name><TAB><absolute path>.
# The default is the one the [Install...] section points at (what Firefox
# actually opens); failing that, the profile marked Default=1.
list_profiles() {
  local root=$1
  [[ -f $root/profiles.ini ]] || die "no profiles.ini in $root (set FIREFOX_ROOT or use --profile)"
  awk -v root="$root" '
    function flush() {
      if (sec ~ /^\[Profile/ && path != "") {
        n++
        names[n] = name; paths[n] = (rel == "1" ? root "/" path : path)
        relpaths[n] = path; marked[n] = def
      }
      name = ""; path = ""; rel = "1"; def = "0"
    }
    /^\[/ { flush(); sec = $0; next }
    {
      eq = index($0, "=")
      if (eq == 0) next
      key = substr($0, 1, eq - 1); val = substr($0, eq + 1)
      sub(/\r$/, "", val)
      if (sec ~ /^\[Install/ && key == "Default" && install == "") install = val
      if (key == "Name") name = val
      if (key == "Path") path = val
      if (key == "IsRelative") rel = val
      if (key == "Default") def = val
    }
    END {
      flush()
      for (i = 1; i <= n; i++) if (install != "" && relpaths[i] == install) chosen = i
      if (!chosen) for (i = 1; i <= n; i++) if (marked[i] == "1") chosen = i
      if (!chosen && n) chosen = 1
      for (i = 1; i <= n; i++) printf "%d\t%s\t%s\n", (i == chosen), names[i], paths[i]
    }
  ' "$root/profiles.ini"
}

firefox_running() {
  pgrep -x firefox >/dev/null 2>&1 || pgrep -x firefox-bin >/dev/null 2>&1
}

install_into() {
  local dir=$1 chrome=$1/chrome
  local uc=$chrome/userChrome.css userjs=$1/user.js

  mkdir -p "$chrome"
  rm -f "$chrome/$css_name"
  if (( link )); then
    ln -s "$repo/$css_name" "$chrome/$css_name"
  else
    cp "$repo/$css_name" "$chrome/$css_name"
  fi

  if [[ ! -f $uc ]]; then
    printf '%s\n' "$import_line" > "$uc"
  elif ! grep -qxF "$import_line" "$uc"; then
    local backup
    backup="$uc.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$uc" "$backup"
    echo "Backed up existing userChrome.css to $backup"
    # @import has to come before every other rule except @charset.
    awk -v line="$import_line" '
      NR == 1 && /^@charset/ { print; print line; done = 1; next }
      NR == 1 { print line; done = 1 }
      { print }
      END { if (!done) print line }
    ' "$backup" > "$uc"
  fi

  if ! grep -qxF "$pref_line" "$userjs" 2>/dev/null; then
    if [[ -f $userjs ]]; then
      local tmp
      tmp=$(mktemp)
      grep -vF "\"$pref_name\"" "$userjs" > "$tmp" || true
      cat "$tmp" > "$userjs"
      rm -f "$tmp"
    fi
    printf '%s\n' "$pref_line" >> "$userjs"
  fi

  echo "Installed into $dir"
}

remove_from() {
  local dir=$1 chrome=$1/chrome
  local uc=$chrome/userChrome.css

  rm -f "$chrome/$css_name"
  if [[ -f $uc ]] && grep -qxF "$import_line" "$uc"; then
    local tmp
    tmp=$(mktemp)
    grep -vxF "$import_line" "$uc" > "$tmp" || true
    cat "$tmp" > "$uc"
    rm -f "$tmp"
    [[ -s $uc ]] || rm -f "$uc"
  fi
  echo "Removed from $dir"
  echo "(Left $pref_name in user.js; it only lets Firefox read userChrome.css.)"
}

mode=install link=0 profile=""
while (( $# )); do
  case $1 in
    --list) mode=list ;;
    --remove|--uninstall) mode=remove ;;
    --link) link=1 ;;
    --profile)
      (( $# >= 2 )) || die "--profile needs a directory"
      profile=$2
      shift ;;
    -h|--help) sed -n '2,20s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [[ $mode == list ]]; then
  list_profiles "$(firefox_root)" | while IFS=$'\t' read -r def name path; do
    printf '%s %-24s %s\n' "$([[ $def == 1 ]] && echo '*' || echo ' ')" "$name" "$path"
  done
  exit 0
fi

if [[ -z $profile ]]; then
  profile=$(list_profiles "$(firefox_root)" | awk -F'\t' '$1 == 1 { print $3; exit }')
  [[ -n $profile ]] || die "couldn't find a default profile (use --profile)"
fi
[[ -d $profile ]] || die "not a directory: $profile"

if [[ $mode == remove ]]; then
  remove_from "$profile"
else
  install_into "$profile"
fi

if firefox_running; then
  echo "Firefox is running: quit and reopen it to see the change."
fi
