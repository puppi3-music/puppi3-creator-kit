#!/bin/sh
# Builds the kit's theme: kit/dist/puppi3-creator-kit-theme.zip from kit/theme/ (Ghost's Source + the kit's hooks,
# kit/theme/KIT.md), checks that nothing site-specific got in, then runs Ghost's theme checker (gscan).
set -e
cd "$(dirname "$0")"
for t in zip unzip; do
  command -v $t >/dev/null || { echo "theme-zip: needs $t (on Linux: sudo apt install zip unzip)" >&2; exit 1; }
done
ZIP=dist/puppi3-creator-kit-theme.zip
mkdir -p dist
rm -f "$ZIP"
(cd theme && zip -rq "../$ZIP" . -x '*.map' -x '.gitattributes' -x '.DS_Store' -x 'KIT.md' -x 'CLAUDE*.md')
# No other site's values: a site theme's own hooks, and the private names of the site the kit is sent from (its
# private-words.txt, at its repo's top; the kit never carries it)
words=$(mktemp); trap 'rm -f "$words"' EXIT
printf '%s\n' 'window\.puppi3' '/\.puppy/' > "$words"
if [ -f ../private-words.txt ]; then grep -v -E '^[[:space:]]*(#|$)' ../private-words.txt >> "$words" || true; fi
leaks=$(unzip -Z1 "$ZIP" | while read -r f; do
          [ "${f%/}" = "$f" ] || continue   # folders
          unzip -p "$ZIP" "$f" | grep -n -i -E -f "$words" | sed "s|^|$f:|" || true
        done)
if [ -n "$leaks" ]; then
  echo "theme-zip: site-specific values in the kit's theme:" >&2
  echo "$leaks" >&2
  exit 1
fi
echo "Built kit/$ZIP"
# Ghost's theme checker needs Node.js (npx); without it the zip is still fine to upload
if command -v npx >/dev/null; then npx -y gscan@6.6.1 --zip "$ZIP"
else echo "theme-zip: $ZIP is ready; Ghost's theme check (gscan) skipped: it needs Node.js (npx)"; fi
