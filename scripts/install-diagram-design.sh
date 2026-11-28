#!/bin/sh
set -eu

revision=795eec47fd376e5dda0b9e056a49520060cd2f13
checksum=e7ca14a49a07a599fe11562428762ac8c2060f3e32e5b2930be78b6e5353b58e
parent=${1:-third_party}
mkdir -p "$parent"
temp=$(mktemp -d "$parent/.diagram-design.XXXXXX")
trap 'rm -rf "$temp"' EXIT
trap 'exit 1' HUP INT TERM

archive="$temp/diagram-design.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
    --connect-timeout 15 --max-time 120 --max-redirs 5 --max-filesize 30000000 \
    --proto '=https' --proto-redir '=https' \
    "https://codeload.github.com/cathrynlavery/diagram-design/tar.gz/$revision" -o "$archive"

if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
else
    printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
fi

root=diagram-design-$revision
tar -xzf "$archive" -C "$temp" "$root/skills/diagram-design" "$root/LICENSE" "$root/THIRD_PARTY_LICENSES.md"
skill="$temp/$root/skills/diagram-design"
mv "$temp/$root/LICENSE" "$temp/$root/THIRD_PARTY_LICENSES.md" "$skill/"
printf '\n' >> "$skill/SKILL.md"
cat "$(dirname "$0")/diagram-design-sumire.md" >> "$skill/SKILL.md"

rm -rf "$parent/diagram-design"
mv "$skill" "$parent/diagram-design"
