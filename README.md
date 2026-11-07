# My Daily Planner

A simple daily planner website for study plans, student lessons and event notes. It runs entirely in the browser: no install, no account, no server.

## How to use

Open `index.html` in your browser, or publish the repo with GitHub Pages (Settings → Pages → deploy from branch).

- **Day**: see one day at a time and add **lessons**, **study sessions** or **other events**. Every event has its own **notes**, and each day has a "Notes for the day" box. Tick an event's checkbox to mark it done.
- **Students**: add your students, then use **Plan next lesson**. When you plan a lesson, the planner shows that student's **last class** (objectives, homework, next steps, notes). Click **Build this lesson from last class** to pre-fill the homework check, review and new objectives from it. Each student also has their full lesson history.
- **Study Plans**: make a plan with a list of topics and a target date, then schedule study sessions for it. When you complete a session, the topics you picked for it are ticked off and the progress bar updates.

## Your data

Everything is saved in this browser's local storage. Use **Export** to download a backup file regularly, and **Import** to restore it or move your data to another computer or browser.

## Apple Pencil planner (PDF)

`pencil-planner/Pencil-Planner-2027.pdf` is a 530-page hyperlinked planner for writing on an iPad with Apple Pencil. Open it on the iPad and import it into GoodNotes, Notability or Noteshelf as a PDF.

- **Pages**: cover, index, year at a glance, yearly goals, 12 months, 53 weeks, a page for every day, 40 lesson plans, a student tracker, 10 study plans and 40 dot-grid notes pages.
- **Links**: the month tabs on the right and the buttons at the top are on every page. Tap a date on a month or year page to open that day, a week number to open the week, and the headings at the top of a page to go back up. Write with the Pencil and tap links with your finger.
- **Other years**: run `python3 pencil-planner/make_planner.py --year 2028` (add `--week-start sunday` if you like). It needs Python with `reportlab` (`pip install reportlab`).
