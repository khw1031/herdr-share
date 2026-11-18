# herdr-share

A layout and a mod for the [Herdr](https://herdr.dev) desktop app, shared for the Herdr gallery.

| Folder | What it is | Add it |
| --- | --- | --- |
| [`main-filter/`](main-filter/) | Layout. Herdr's `main` layout with a machine filter (All / This computer / each machine) over the sidebar's Spaces and Agents lists, and a Scheduled jobs row in the sidebar footer. | `herdr.dev/layouts/khw1031/main-filter` |
| [`job-scheduler/`](job-scheduler/) | Mod. Schedules coding-agent runs: a sidebar footer row and a tab for adding jobs that start an agent at a set time, from Herdr's timer or from a machine's crontab. | `herdr.dev/mods/khw1031/job-scheduler` |

Each folder has a `RECIPE.md` (a brief an agent can build it from), a `preview.png`, and the files of one working build.

## Add one

1. Open Herdr and start your coding agent in a terminal.
2. Paste `herdr.dev/layouts/khw1031/main-filter` or `herdr.dev/mods/khw1031/job-scheduler` and ask the agent to add it.
3. The agent reads the recipe and the files, tells you what they run, copies them into `~/.config/herdr-app`, runs `herdr-app check` on each mod, and, for the layout, switches to it. `layout.switch` (`cmd-shift-l` on macOS) switches back to your own layout.

Read **Watch out** in each `RECIPE.md` before adding. `job-scheduler` runs programs (`sh`, `python3`, `crontab`, `hc run`), can add and remove crontab lines, and reads the job lists saved on your other machines.

## License

Copyright 2026 khw1031. Licensed under the Apache License, Version 2.0 ([LICENSE](LICENSE)).

- `main-filter/mods/agents-filter` and `main-filter/mods/spaces-filter` are modified copies of Herdr's built-in Agents and Spaces mods (`agents` and `spaces`, Herdr 0.1.16). Herdr is licensed under Apache-2.0. The changes add the machine filter, shared through the key `machine.filter`. Each changed `main.js` says so in its first lines.
- `main-filter/layouts/main-filter.json` is a modified copy of Herdr's `main` layout (0.1.14).
- `job-scheduler` uses three [Lucide](https://github.com/lucide-icons/lucide) icons (`clock.svg`, `settings.svg`, `plus.svg`, as shipped in Herdr's `workspace-chrome` mod) under the ISC License:

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

This repository is not part of the Herdr project.
