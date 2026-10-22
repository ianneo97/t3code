#!/usr/bin/env bash
# Rebuild and install Ian's T3 Code fork, "T3 Code (Beta)": merge the latest
# upstream main and the switch-at-limit feature into ian/daily, run the
# feature's tests and build an unsigned arm64 app on the Air (no update feed),
# back up T3's data, then install and open the app.
# Usage: scripts/ian-daily-update.sh                 merge, test, build, install
#        scripts/ian-daily-update.sh --no-install    stop after the build
#        scripts/ian-daily-update.sh --install-only  install the newest build in release/
set -euo pipefail

REPO="$HOME/Projects/personal/apps/t3code"
DAILY=ian/daily
FEATURE=feat/switch-account-at-limit
APP_NAME="T3 Code (Beta).app"
BACKUPS="$HOME/.t3-backups"
SETUP='source ~/.nvm/nvm.sh >/dev/null && nvm use 26.12.1 >/dev/null && . ~/.config/vite-plus/env && export PATH="$HOME/.cargo/bin:$PATH"'
TESTS="apps/server/src/orchestration-v2/LimitAccountSwitch.test.ts apps/server/src/orchestration-v2/LimitAccountSwitch.integration.test.ts packages/shared/src/usageLimitSwitch.test.ts packages/client-runtime/src/state/limitSwitchTargets.test.ts"

mode="${1:-all}"
case "$mode" in
  all | --no-install | --install-only) ;;
  *) echo "usage: $0 [--no-install | --install-only]" >&2; exit 2 ;;
esac

cd "$REPO"
if [ "$mode" = --install-only ]; then
  dmg="$(ls -t release/T3-Code-*-arm64.dmg 2>/dev/null | head -1 || true)"
  if [ -z "$dmg" ]; then
    echo "ian-daily-update: no build in release/. Run without --install-only first." >&2
    exit 1
  fi
else
  if [ -n "$(git status --porcelain)" ]; then
    echo "ian-daily-update: $REPO has uncommitted changes. Commit or stash them first." >&2
    exit 1
  fi
  git fetch --quiet --tags upstream main
  git switch --quiet "$DAILY"
  for ref in upstream/main "$FEATURE"; do
    if ! git merge --no-edit --quiet "$ref"; then
      git merge --abort
      echo "ian-daily-update: merging $ref into $DAILY conflicts. Resolve it by hand, then rerun." >&2
      exit 1
    fi
  done

  air-run -- "$SETUP && vp i && vp test run $TESTS"

  # The packages say 0.1.1; upstream stamps the real version on its nightly tags.
  base="$(git describe --tags --abbrev=0 --match 'v*-nightly.*' upstream/main | sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/')"
  # Semver forbids leading zeros, so 09:05 becomes 905.
  version="$base-preview.$(date +%Y%m%d).$((10#$(date +%H%M)))"
  air-run --timeout 3600 -- "$SETUP && env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY T3CODE_DESKTOP_VERSION=$version vp run dist:desktop:dmg:arm64"

  dmg="release/T3-Code-$version-arm64.dmg"
  mkdir -p release
  # The link to the Air can stall; --partial lets a rerun resume the copy.
  rsync -a --partial "air:Projects/personal/apps/t3code/$dmg" "$dmg"
  echo "ian-daily-update: built $dmg"
  [ "$mode" = --no-install ] && exit 0
fi

# Both apps share ~/.t3 and refuse to run a second server on it. No pipe here:
# under pipefail, `ps | grep -q` reports "not running" when grep exits early.
procs="$(ps -axo command=)"
for app in "T3 Code (Nightly)" "T3 Code (Beta)"; do
  case "$procs" in
    *"/$app.app/Contents/MacOS/"*)
      echo "ian-daily-update: quit $app first (Cmd+Q), then run: $0 --install-only" >&2
      exit 1
      ;;
  esac
done

mnt="$(hdiutil attach -nobrowse -readonly "$dmg" | awk -F'\t' '/\/Volumes\//{print $NF}')"
trap 'hdiutil detach -quiet "$mnt" 2>/dev/null || true' EXIT
if [ -e "$mnt/$APP_NAME/Contents/Resources/app-update.yml" ]; then
  echo "ian-daily-update: this build has an update feed, which would replace it with the official app. Not installing." >&2
  exit 1
fi

# A new build can migrate the database, and migrations only go forward.
backup="$BACKUPS/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
sqlite3 "$HOME/.t3/userdata/statev2.sqlite" ".backup '$backup/statev2.sqlite'"
cp -p "$HOME"/.t3/userdata/*.json "$backup"/
ls -dt "$BACKUPS"/*/ | tail -n +4 | while read -r old; do rm -rf "$old"; done
echo "ian-daily-update: backed up T3 data to $backup (the newest 3 are kept)"

rm -rf "/Applications/$APP_NAME"
ditto "$mnt/$APP_NAME" "/Applications/$APP_NAME"
echo "ian-daily-update: installed $(basename "$dmg") as /Applications/$APP_NAME"
open -a "/Applications/$APP_NAME"
