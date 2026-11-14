# Pen Planner

A daily planner website you write in with Apple Pencil: one page per day with your **morning and night routines**, your **Google Calendar** events, your **tasks** and your **study notes**. It runs entirely in the browser: no install, no account, no server.

## How to use

There are two ways to open it:

- **As a Claude page (easiest):** https://claude.ai/artifact/PVB6p4xWCwFUvz8EHewRmv. Open it in the Claude app or in Safari on your iPad. Everything you write is saved in your Claude account, and the Calendar card reads your Google Calendar through your Claude connector, so there's nothing to set up. `artifact/pen-planner.html` is that page; rebuild it with `python3 tools/build_artifact.py` after changing `index.html`, `pen.css` or `pen.js`.
- **On GitHub Pages:** publish the repo (Settings → Pages → deploy from branch) and open the link in Safari. Here your writing is saved in Safari on that iPad, and the calendar uses the Apps Script setup described below.

- **Tasks**: write on the empty line ("Write a new task…") and a new empty line appears underneath. Tap the circle to mark a task done. **→** moves it to tomorrow, **×** deletes it.
- **Unfinished tasks follow you**: on today's page, anything not done from earlier days shows under "Still to do from earlier days". Tick it off there, or tap **Move to today**.
- **Study notes**: tap **New study note** on any day. Type the subject (e.g. Biology), pick lined, grid, dotted or blank paper, and write. The page grows as you reach the bottom, or tap **+ More space**.
- **All study notes**: the *Study notes* tab shows every note, newest first. Tap a subject to see only those notes.
- **Morning & night routines**: the first card of each day is your morning routine, the last is your night routine. Tap a step to tick it. The dots show the last 7 days and the 🔥 counts how many days in a row you did the whole routine. Tap **Edit** to change the steps.
- **Calendar tab**: the whole month at a glance. Each day shows its Google Calendar events, how many tasks are still to do (or ✓ when all are done), study notes, and two dots for the morning and night routines. Tap a day to open it; use ‹ › to change month.
- **Routines tab**: the last 30 days of each routine, step by step, with your streak and how many full days you managed this week and this month. Tap a square to fill in a day you forgot.
- **Google Calendar**: tap **Connect Google Calendar** on the Calendar card (or ••• → Google Calendar connection) and follow the steps. You copy a small script into script.google.com, deploy it as a web app, and paste its link back into the planner. After that, each day shows that day's events. The script only reads your calendars, and the link is private to you: don't share it.
- **Pen tools** (bar at the bottom): pen, highlighter, eraser, 5 ink colours, 3 sizes, undo and redo. The Pencil writes and your finger scrolls; tap the hand button if you also want to write with a finger.

## Your data

Everything is saved in the browser on your iPad. Safari can clear data from websites you haven't opened for a few weeks, so:

1. In Safari tap **Share → Add to Home Screen** and always open the planner from that icon. Apps on the Home Screen keep their data, and the planner works offline too.
2. Every now and then use **••• → Download a backup**. **Restore a backup** brings it back on any device.

## Classic planner

The earlier typed planner (lessons, students, study plans) is still at `classic.html`, with all its saved data, and is linked from the ••• menu.
