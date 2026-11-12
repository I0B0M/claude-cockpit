# session-hud

Four tiles in the band above the prompt of the Claude Code desktop app: the 5-hour limit, the weekly limit, the context window and the prompt cache's time left. Each turns green, amber, orange, then red as it fills; at orange and red the tile's border takes the colour too. While Claude works through a task list, a row above the tiles shows the current step.

```
/plugin install session-hud --marketplace I0B0M/claude-cockpit
```

Option `cacheMinutes` (`60` or `5`, default `60`): how long your prompt cache lives.

It reads only the figures Claude Code already reports (`session.usage` and `session.measure`): no model calls, no network, no files.

Part of [claude-cockpit](../../README.md). MIT.
