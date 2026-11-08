# mac-sonde

A small line above the Claude Code prompt that shows how hard your Mac is working, refreshed every 3 seconds:

```
● This Mac · CPU 19 % ▁▂▅█▃ · GPU 48 % · RAM 39.7 GiB ▅▅▅▅▅ · 58 °C ▃▃▄▄▅ · load 34 % ▂▃▃▄▃ · swap 5.0 GiB
```

- **CPU**, **GPU**, **RAM** (counted like Activity Monitor: app memory, wired and compressed, without the cache), **temperature** (optional, see below), **load** (1-minute load average divided by the number of cores: 100 % means every core is busy, more means tasks are waiting) and **swap**.
- Each value is followed by a sparkline of the last 10 readings (30 seconds), coloured green, orange or red as it rises.
- The dot at the start sums it up: orange from 70 % or 85 °C, red from 90 % or 95 °C.
- When the window is narrow, the sparklines shorten, then drop one by one (RAM first, then temperature, then load, CPU last), then the swap goes. The line is cut at the end, never wrapped.
- `/mac` hides the line, and shows it again. The choice is remembered across sessions.

**macOS only.** It reads the system with `sysctl`, `vm_stat`, `ioreg` and `ps`, which ship with macOS; nothing to install, no administrator rights, nothing sent anywhere. On another system the line shows "no reading".

> Claude Code mods are in early access: the API may change and break this mod until it is updated.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mac-sonde --marketplace tiber76/mac-sonde
```

Answer `y` to add the marketplace, then pick a scope (Enter for your user). The line appears right away.

From a shell:

```bash
claude plugin install mac-sonde --marketplace tiber76/mac-sonde
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `tiber76/mac-sonde`, then Add plugin.

## Settings

Run `/config` and look for the mac-sonde rows:

| Setting | Values | Default |
| --- | --- | --- |
| Language | `en` (English) or `fr` (français) | `en` |
| Temperature file | path to a file, `~/` allowed | empty: no temperature |

## Temperature (optional)

macOS gives no temperature to ordinary commands, so mac-sonde reads it from a file you keep fresh. The file holds one line, the time in Unix seconds then the temperature in degrees Celsius:

```
1762620000 58
```

A value older than 60 seconds is ignored, so the temperature disappears on its own if your tool stops.

On Apple Silicon, [macmon](https://github.com/vladkens/macmon) reads it without administrator rights. The `extras/` folder holds a helper script and a launchd service that keep `~/.mac-sonde/temperature.txt` up to date:

```bash
brew install macmon
mkdir -p ~/.mac-sonde
cp extras/mac-sonde-temperature.sh ~/.mac-sonde/
sed "s|YOUR_HOME|$HOME|" extras/mac-sonde-temperature.plist > ~/Library/LaunchAgents/mac-sonde.temperature.plist
launchctl load ~/Library/LaunchAgents/mac-sonde.temperature.plist
```

Then set **Temperature file** to `~/.mac-sonde/temperature.txt` in `/config`. To stop it: `launchctl unload ~/Library/LaunchAgents/mac-sonde.temperature.plist`.

Why a background service: run from inside Claude Code's command sandbox, macmon cannot subscribe to the sensors.

## Develop

```bash
claude plugin test .
claude plugin validate . --profile directory
claude --plugin-dir .
```

## License

MIT, see [LICENSE](LICENSE).
