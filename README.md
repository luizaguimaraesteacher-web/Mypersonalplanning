# Pen Planner

A daily planner website you write in with Apple Pencil: one page per day with your **morning and night routines**, your **Google Calendar** events, your **tasks** and your **study notes**. It runs entirely in the browser: no install, no account, no server.

## How to use

There are two ways to open it:

- **As a Claude page (easiest):** https://claude.ai/artifact/PVB6p4xWCwFUvz8EHewRmv. Open it in the Claude app or in Safari on your iPad. Everything you write is saved in your Claude account, and the Calendar card reads your Google Calendar through your Claude connector, so there's nothing to set up. `artifact/pen-planner.html` is that page; rebuild it with `python3 tools/build_artifact.py` after changing `index.html`, `pen.css` or `pen.js`.
- **On GitHub Pages:** publish the repo (Settings → Pages → deploy from branch) and open the link in Safari. Here your writing is saved in Safari on that iPad, and the calendar uses the Apps Script setup described below.

- **Tasks**: write on the empty line ("Write a new task…") and a new empty line appears underneath. Tap the circle to mark a task done. **→** moves it to tomorrow, **×** deletes it.
- **Notes next to each task**: every task has its own handwriting space beside it (under it on a narrow screen, where **✎** opens it). The note moves with the task and is deleted with it.
- **Routines beside your tasks**: the morning and night routines sit side by side right above the task list.
- **Money**: the *Money* tab lists the month's expenses by day, with the total, a monthly budget bar, spending by category and **⤓ CSV**. **+ Expense** (there, or on each day's Money card) asks for the amount, what it was, category, how you paid and the date; tap an expense to change or delete it.
- **Calendars that only show "Busy"**: a calendar shared as *free/busy only* is marked "busy only", and its events show as *Busy*. **+ Calendars → Only seeing "Busy"?** explains how to switch the sharing to *See all event details*.
- **Unfinished tasks follow you**: on today's page, anything not done from earlier days shows under "Still to do from earlier days". Tick it off there, or tap **Move to today**.
- **Study notes**: tap **New study note** on any day. Type the subject (e.g. Biology), pick lined, grid, dotted or blank paper, and write. The page grows as you reach the bottom, or tap **+ More space**.
- **All study notes**: the *Study notes* tab shows every note, newest first. Tap a subject to see only those notes.
- **Morning & night routines**: the two routine cards at the top of each day. Tap a step to tick it. The dots show the last 7 days and the 🔥 counts how many days in a row you did the whole routine. Tap **Edit** to change the steps.
- **Calendar tab**: the whole month at a glance. Each day shows its Google Calendar events, how many tasks are still to do (or ✓ when all are done), study notes, and two dots for the morning and night routines. Tap a day to open it; use ‹ › to change month.
- **Several calendars**: inside Claude the planner shows every Google calendar on your account, each in its own colour. Tap a calendar's button (on the Calendar tab or the day's Calendar card) to hide or show it.
- **More calendars**: **+ Calendars** (next to the calendar buttons) lists every calendar with a tick box, and adds a calendar from another Google account by its address once it's shared with the account connected to Claude.
- **Edit everything**: tap a Google Calendar event on a day page to change its name, day, time, place or notes, or to delete it; **+ Event** adds a new one to the calendar you choose. Tasks: write or erase on them, tick them, **→** moves them to any day, **×** deletes them. Study notes: change subject, date, paper, or delete. Routines: **Edit** changes the steps. (Event editing works in the Claude version.)
- **Classes & notes** (on each day): your Granola notes for that day (tap **Summary** to read them, **Open ↗** to go to Granola), and the classes you recorded in the planner.
- **Record a class**: tap **● Record** next to a class in the Calendar card (or **Record a class**). The class page has: how it went (happened / student missed / cancelled / rescheduled), a recording box, what you covered, homework and notes, plus **Send recording to Granola**. On iPad, tap the recording box and use the keyboard's microphone to dictate (Claude pages can't use the microphone in Safari or the iPad app); in the Claude desktop app or Chrome, **Start recording** writes down what is said live.
- **Class notes inside events**: each class in the day's Calendar card shows what you covered, the homework and your notes, plus its Granola notes (tap **📝 Granola notes** to read the summary).
- **Last class, reschedule, cancel**: a class page shows that student's previous class (homework to check first). **Rescheduled** moves the Google Calendar event to the day and time you pick; **Cancelled** renames it "Cancelled: …" and frees the time; unmarking puts it back. Guests are never emailed.
- **Event pages**: tap a class in the calendar (day page or month) to open everything about it in one place: the Google event details, Edit / Delete, how it went (happened, missed, cancelled, rescheduled), the last class, what you covered, homework, notes, recording, Granola, and **Save notes to Google Calendar** (adds them to the event's description).
- **Study plans** (*Studies* tab): every plan has its own page with **Overdue**, **Next topics**, **All topics** (by module or subject) and **Notes**. **+ New study plan** lets you paste or photograph what you need to study and **✦ Organize with Claude** turns it into days (or **Spread it out myself**, one line per day). On a plan, **✦ Reorganize with Claude** changes it the way you describe, **Replan from today** moves what's left forward, and each topic's date can be changed. Each day's *Study plan* card shows what's due from every plan. A personal plan can be kept in `private/` (not committed); `tools/build_artifact.py` adds it only to the published Claude page.
- **Topics**: tap a topic (in a plan or on the day's Study plan card) to open it: a handwriting page just for that topic (✎), and its Granola recording (🎙). Record the study session in the Granola app with the topic's name (**Copy name** helps), then tap **⟳ Sync with Granola**: matching Granola notes are linked to their topics, with summaries; other notes from that day can be linked by hand. A plan's **⟳ Sync with Granola** does every topic at once.
- **Picture of the day & gratitude**: near the end of each day, add a photo (take one or pick one; it's resized and saved with the planner) with a caption, and write three things you're grateful for with Apple Pencil. Photos also show as tiny thumbnails on the month calendar.
- **Notes PDFs**: **⤓ Notes PDF** on each plan (and on its card) compiles that plan's written notes in topic order; **⤓ All notes PDF** on the Studies tab compiles every plan (each with a title page) plus your other study notes.
- **Hello Pro Hub**: the button at the top opens the Hub.
- **Notes to PDF**: **⤓ PDF** on a note, on a plan's Notes, or on the Study notes list turns your handwritten notes into an A4 PDF.
- **Routines tab**: the last 30 days of each routine, step by step, with your streak and how many full days you managed this week and this month. Tap a square to fill in a day you forgot.
- **Google Calendar**: tap **Connect Google Calendar** on the Calendar card (or ••• → Google Calendar connection) and follow the steps. You copy a small script into script.google.com, deploy it as a web app, and paste its link back into the planner. After that, each day shows that day's events. The script only reads your calendars, and the link is private to you: don't share it.
- **Pen tools** (bar at the bottom): pen, highlighter, eraser, 5 ink colours, 3 sizes, undo and redo. The Pencil writes and your finger scrolls; tap the hand button if you also want to write with a finger.

## Your data

Everything is saved in the browser on your iPad. Safari can clear data from websites you haven't opened for a few weeks, so:

1. In Safari tap **Share → Add to Home Screen** and always open the planner from that icon. Apps on the Home Screen keep their data, and the planner works offline too.
2. Every now and then use **••• → Download a backup**. **Restore a backup** brings it back on any device.

## Classic planner

The earlier typed planner (lessons, students, study plans) is still at `classic.html`, with all its saved data, and is linked from the ••• menu.
