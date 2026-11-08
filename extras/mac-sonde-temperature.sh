#!/usr/bin/env bash
# Optional helper for mac-sonde: writes the CPU temperature to ~/.mac-sonde/temperature.txt
# as "<unix time in seconds> <degrees Celsius>", every 5 s. Needs macmon (brew install macmon),
# Apple Silicon only, no administrator rights.
#
# The value is the hottest CPU die sensor ("PMU tdie…" in `macmon debug`), as CleanMyMac or iStat Menus show it,
# not macmon's average of every sensor (cpu_temp_avg), which reads 10 to 20 °C lower under load.
# If no die sensor shows up (a chip macmon does not know yet), it falls back to that average.
set -u
trap 'exit 130' INT

OUT="$HOME/.mac-sonde/temperature.txt"
PERIOD_S=5
MACMON="$(command -v macmon || echo /opt/homebrew/bin/macmon)"

hottest() {
  "$MACMON" debug 2>/dev/null | sed -nE 's/^ *PMU tdie[0-9]+: *([0-9]+(\.[0-9]+)?)$/\1/p' | sort -n | tail -n 1
}

average() {
  "$MACMON" pipe -s 1 -i 1000 2>/dev/null | sed -nE 's/.*"cpu_temp_avg":([0-9]+(\.[0-9]+)?).*/\1/p'
}

mkdir -p "$(dirname "$OUT")"
while :; do
  deg=$(hottest)
  [ -n "$deg" ] || deg=$(average)
  case "$deg" in
    '' | 0 | 0.*) ;;
    *) printf '%s %s\n' "$(date +%s)" "$deg" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT" ;;
  esac
  sleep "$PERIOD_S"
done
