# mac-sonde

A small line above the Claude Code prompt that shows how hard your Mac is working, refreshed every 3 seconds by default:

![The mac-sonde line in its four sparkline styles: smooth, filled, line and bars, coloured green, orange and red](docs/styles.svg)

<sub>Illustrations drawn from the mod's own drawing rules with sample readings, not screenshots.</sub>

- **CPU**, **GPU**, **RAM** (counted like Activity Monitor: app memory, wired and compressed, without the cache), **temperature** (optional, see below), **load** (1-minute load average divided by the number of cores: 100 % means every core is busy, more means tasks are waiting) and **swap**.
- Each value is followed by a sparkline coloured by level: green below 70 %, orange from 70 %, red from 90 % (for the temperature: orange from 85 °C, red from 95 °C, height from 30 °C to 100 °C).
- The dot at the start sums it up with the same thresholds.
- The sparklines start empty at each new session.
- `/mac` hides the line, and shows it again. The choice is remembered across sessions.

**macOS only.** It reads the system with `sysctl`, `vm_stat`, `ioreg` and `ps`, which ship with macOS; nothing to install, no administrator rights, nothing sent anywhere. On another system the line shows "no reading".

> Claude Code mods are in early access: the API may change and break this mod until it is updated.

## Four sparkline styles

| Style | Looks like | History shown |
| --- | --- | --- |
| `smooth` (default) | a real continuous curve, area filled, its colour sliding from one reading to the next; drawn as a small image | 20 readings, 1 min |
| `filled` | `⣀⣤⣶⣿`: the curve in braille dots, area filled, two readings per character, 4 heights | 20 readings, 1 min |
| `line` | `⣀⡠⠊`: the line alone, in braille dots | 20 readings, 1 min |
| `bars` | `▁▃▅█`: one reading per character, 8 heights | 10 readings, 30 s |

`smooth` is an image, which a terminal cannot draw: in a terminal session the line falls back to `filled`. The durations are at the normal sampling rate.

Pick one when you install the mod (the **Sparkline style** setting), and switch at any time:

```
/mac smooth
/mac filled
/mac line
/mac bars
```

The style you pick with `/mac` is remembered across sessions and wins over the install setting. `/mac` alone still hides or shows the line; an unknown word shows the help and changes nothing. The French names (`lisse`, `pleine`, `courbe`, `barres`) work too.

## Sampling rate

| Rate | One reading every |
| --- | --- |
| `slow` | 10 s |
| `normal` (default) | 3 s |
| `fast` | 1 s |

Pick one when you install the mod (the **Sampling rate** setting), or switch with `/mac slow`, `/mac normal` or `/mac fast`; the choice is remembered and wins over the install setting (`lent`, `normal`, `rapide` work too). There is no faster rate on purpose: each reading runs five system commands, and doing that more than once a second would weigh on the very CPU it measures.

## Narrow windows

The line always stays on one row. Each sparkline is 10 characters at most. When space runs out, the sparklines shorten together down to 5 characters, then drop one by one: RAM first, then temperature, then load, the CPU last. Then the swap goes. Past that, the line is cut at the end, never wrapped.

![The line at four widths: wide with every sparkline, medium without the RAM one, narrow with only the CPU one, very narrow cut at the end](docs/widths.svg)

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
| Sparkline style | `smooth`, `filled`, `line` or `bars` | `smooth` |
| Sampling rate | `slow`, `normal` or `fast` | `normal` |
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
