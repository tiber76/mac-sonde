#!/usr/bin/env bash
# Optional helper for mac-sonde: writes the CPU temperature to ~/.mac-sonde/temperature.txt
# as "<unix time in seconds> <degrees Celsius>", every 15 s. Needs macmon (brew install macmon),
# Apple Silicon only, no administrator rights.
set -u
trap 'exit 130' INT

OUT="$HOME/.mac-sonde/temperature.txt"
PERIOD_MS=15000
MACMON="$(command -v macmon || echo /opt/homebrew/bin/macmon)"

mkdir -p "$(dirname "$OUT")"
while :; do
  "$MACMON" pipe -i "$PERIOD_MS" |
    while read -r line; do
      deg=$(printf '%s' "$line" | sed -nE 's/.*"cpu_temp_avg":([0-9]+).*/\1/p')
      [ "${deg:-0}" -gt 0 ] && printf '%s %s\n' "$(date +%s)" "$deg" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
    done
  sleep 15
done
