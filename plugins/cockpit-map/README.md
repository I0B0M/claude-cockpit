# cockpit-map

A live map of Claude Code's work in the band above the prompt. Files, shell, network, browser, agents, skills, hooks, memory and the model light up as they are used; errors turn red. Press **⤢** to enlarge it, then press a station to list what it was used for this session.

```
/plugin install cockpit-map --marketplace I0B0M/claude-cockpit
```

`/cockpit-map` opens the big map too.

## Based on lot-map

This is a modified copy of [lot-map](https://github.com/alexeyw/lot-map) by Aleksei Volodin, taken at commit `f230865` (version 0.4.2), MIT licensed; the original license and copyright are kept in [LICENSE](LICENSE). The map drawing, the station classifier, the languages and the options are lot-map's. Changes:

- The map no longer opens a pane at start. A compact 200px map sits at the left of the band above the prompt, with larger icons and names, and no model name or counts.
- A **⤢** button on the small map opens the big map in a pane.
- In the big map, each station's name is a button on the map, and a row of station buttons with counts sits beneath it.
- Pressing a station lists each name used there this session (file, command, host, skill, agent, hook or model), how many times, how long ago, and how many failed. Names only, at most 60 per station.
- Renamed to `cockpit-map` so it can be installed beside the original.

lot-map's options (`language`, `theme`, `colors`, `layout`, memory settings and the rest) all still apply; see the [lot-map README](https://github.com/alexeyw/lot-map#options).

What it handles and keeps: [PRIVACY.md](PRIVACY.md).
