#!/usr/bin/env python3
"""Build a hyperlinked PDF planner for writing with Apple Pencil on an iPad.

Import the PDF into GoodNotes, Notability, Noteshelf or any PDF note app.
Every tab, date, week number and title is a link, so you can jump around
with a finger tap while writing with the Pencil.

Usage:
    python3 make_planner.py                 # next year, weeks start Monday
    python3 make_planner.py --year 2027 --week-start sunday
"""
import argparse
import calendar
import datetime as dt
import os

from reportlab.lib.colors import HexColor, white
from reportlab.pdfgen import canvas

# iPad-friendly 4:3 landscape page.
W, H = 1024, 768
SB = 58                  # month tab bar on the right
CX0, CX1 = 36, W - SB - 22
HEAD = 96
CY1, CY0 = H - HEAD, 30  # content area top / bottom

PAPER = HexColor("#fbfaf7")
INK = HexColor("#2b2a28")
MUTED = HexColor("#77736b")
LINE = HexColor("#e4e0d7")
DOT = HexColor("#c9c4b9")
TAB = HexColor("#efece5")
SHADE = HexColor("#f3f1ec")
LESSON, LESSON_SOFT = HexColor("#3f6fd8"), HexColor("#e7eefc")
STUDY, STUDY_SOFT = HexColor("#2e9b6a"), HexColor("#e3f4ec")
OTHER, OTHER_SOFT = HexColor("#b07a2a"), HexColor("#f7eedf")

N_LESSONS, N_STUDY, N_NOTES, N_STUDENT_PAGES = 40, 10, 40, 3
NAV = [("Year", "year"), ("Goals", "goals"), ("Lessons", "lessons"),
       ("Students", "students"), ("Study", "study"), ("Notes", "notes")]


class Planner:
    def __init__(self, year, out, week_start):
        self.year = year
        self.ws = week_start  # 0 = Monday, 6 = Sunday
        self.c = canvas.Canvas(out, pagesize=(W, H), pageCompression=1)
        self.c.setTitle(f"{year} Planner")
        self.c.setAuthor("My Personal Planning")
        first, last = dt.date(year, 1, 1), dt.date(year, 12, 31)
        start = first - dt.timedelta(days=(first.weekday() - week_start) % 7)
        self.weeks = []
        while start <= last:
            self.weeks.append([start + dt.timedelta(days=i) for i in range(7)])
            start += dt.timedelta(days=7)
        self.week_of = {d: i + 1 for i, wk in enumerate(self.weeks) for d in wk}
        self.dow = [calendar.day_abbr[(week_start + i) % 7] for i in range(7)]

    # ---------- drawing helpers ----------
    def link(self, key, x0, y0, x1, y1):
        self.c.linkRect("", key, (x0, y0, x1, y1), relative=0, thickness=0)

    def text(self, x, y, s, size=11, font="Helvetica", color=INK, align="left"):
        c = self.c
        c.setFont(font, size)
        c.setFillColor(color)
        {"left": c.drawString, "center": c.drawCentredString,
         "right": c.drawRightString}[align](x, y, s)

    def pill(self, x, y, label, key=None, active=False, w=None, h=22, fill=TAB, ink=INK):
        c = self.c
        w = w or c.stringWidth(label, "Helvetica-Bold", 10) + 22
        c.setFillColor(INK if active else fill)
        c.roundRect(x, y, w, h, h / 2, stroke=0, fill=1)
        self.text(x + w / 2, y + h / 2 - 3.5, label, 10, "Helvetica-Bold",
                  white if active else ink, "center")
        if key:
            self.link(key, x, y, x + w, y + h)
        return w

    def box(self, x, y, w, h, title=None, color=MUTED, fill=None):
        c = self.c
        c.setStrokeColor(LINE)
        c.setLineWidth(1)
        if fill is not None:
            c.setFillColor(fill)
        c.roundRect(x, y, w, h, 10, stroke=1, fill=1 if fill is not None else 0)
        if title:
            c.setFillColor(color)
            c.circle(x + 16, y + h - 17, 3.5, stroke=0, fill=1)
            self.text(x + 25, y + h - 21, title.upper(), 9.5, "Helvetica-Bold", color)
            return y + h - 34
        return y + h - 10

    def lines(self, x0, x1, ytop, ybot, step=26, checks=False):
        c = self.c
        c.setStrokeColor(LINE)
        c.setLineWidth(0.8)
        y = ytop - step
        while y >= ybot - 0.1:
            lx = x0
            if checks:
                c.roundRect(x0, y + 3, 11, 11, 2.5, stroke=1, fill=0)
                lx = x0 + 18
            c.line(lx, y, x1, y)
            y -= step

    def dots(self, x0, y0, x1, y1, step=18):
        c = self.c
        c.setStrokeColor(DOT)
        c.setLineWidth(1.6)
        c.setLineCap(1)
        p = c.beginPath()
        x = x0
        while x <= x1:
            y = y0
            while y <= y1:
                p.moveTo(x, y)
                p.lineTo(x, y)
                y += step
            x += step
        c.drawPath(p, stroke=1, fill=0)
        c.setLineCap(0)

    # ---------- page frame ----------
    def new_page(self, key, month=None, section=None, outline=None, level=0):
        c = self.c
        c.setFillColor(PAPER)
        c.rect(0, 0, W, H, stroke=0, fill=1)
        c.bookmarkPage(key, fit="Fit")
        if outline:
            c.addOutlineEntry(outline, key, level=level)
        self.sidebar(month)
        self.nav(section)

    def sidebar(self, active):
        c = self.c
        x0, top, bot = W - SB, H - 14, 14
        h = (top - bot) / 12
        for m in range(1, 13):
            y = top - m * h
            on = m == active
            c.setFillColor(INK if on else TAB)
            c.roundRect(x0 + 4, y + 3, SB - 12, h - 6, 9, stroke=0, fill=1)
            self.text(x0 + 4 + (SB - 12) / 2, y + h / 2 - 4, calendar.month_abbr[m].upper(),
                      10.5, "Helvetica-Bold", white if on else MUTED, "center")
            self.link(f"m{m}", x0 + 4, y + 3, W - 8, y + h - 3)

    def nav(self, active):
        c = self.c
        widths = [c.stringWidth(l, "Helvetica-Bold", 10) + 22 for l, _ in NAV]
        x = CX1 - sum(widths) - 6 * (len(NAV) - 1)
        for (label, key), w in zip(NAV, widths):
            self.pill(x, H - 46, label, key, active == key, w)
            x += w + 6

    def header(self, title, crumbs=(), sub=None, prev=None, nxt=None, color=INK):
        c = self.c
        self.text(CX0, H - 58, title, 28, "Helvetica-Bold", color)
        x, y = CX0, H - 81
        for i, (label, key) in enumerate(crumbs):
            if i:
                self.text(x, y, "  ›  ", 11.5, "Helvetica", MUTED)
                x += c.stringWidth("  ›  ", "Helvetica", 11.5)
            w = c.stringWidth(label, "Helvetica-Bold", 11.5)
            self.text(x, y, label, 11.5, "Helvetica-Bold", MUTED)
            self.link(key, x - 2, y - 4, x + w + 2, y + 13)
            x += w
        if sub:
            self.text(x + (14 if crumbs else 0), y, sub, 11.5, "Helvetica", MUTED)
        # previous / next
        xr = CX1
        if nxt:
            xr -= self.pill(xr - 64, H - 88, "Next  ›", nxt, w=64) + 6
        if prev:
            self.pill(xr - 64, H - 88, "‹  Prev", prev, w=64)
        c.setStrokeColor(LINE)
        c.setLineWidth(1)
        c.line(CX0, CY1 + 4, CX1, CY1 + 4)

    def finish(self):
        self.c.showPage()

    # ---------- pages ----------
    def cover(self):
        c = self.c
        c.setFillColor(PAPER)
        c.rect(0, 0, W, H, stroke=0, fill=1)
        c.bookmarkPage("cover", fit="Fit")
        c.addOutlineEntry("Cover", "cover")
        self.sidebar(None)
        cx = (CX0 + CX1) / 2
        self.dots(CX0 + 10, CY0 + 10, CX1 - 10, H - 40, 24)
        c.setFillColor(PAPER)
        c.roundRect(cx - 260, H / 2 - 150, 520, 300, 22, stroke=0, fill=1)
        c.setStrokeColor(LINE)
        c.roundRect(cx - 260, H / 2 - 150, 520, 300, 22, stroke=1, fill=0)
        self.text(cx, H / 2 + 40, str(self.year), 96, "Helvetica-Bold", INK, "center")
        self.text(cx, H / 2 - 10, "PLANNER", 20, "Helvetica-Bold", MUTED, "center")
        for i, (lbl, col) in enumerate([("Lessons", LESSON), ("Study", STUDY), ("Life", OTHER)]):
            x = cx - 120 + i * 90
            c.setFillColor(col)
            c.circle(x, H / 2 - 47, 4, stroke=0, fill=1)
            self.text(x + 9, H / 2 - 51, lbl, 12, "Helvetica", INK)
        self.pill(cx - 60, H / 2 - 115, "Open planner  ›", "index", w=120, h=28)
        self.finish()

    def index(self):
        self.new_page("index", outline="Index")
        self.header("Index", sub=f"Tap anything to jump · {self.year}")
        c = self.c
        # months
        y0 = CY1 - 20
        bw, bh, gap = 140, 56, 12
        top = self.box(CX0, y0 - 3 * (bh + gap) - 46, 4 * bw + 3 * gap + 32,
                       3 * (bh + gap) + 46, "Months", INK)
        for m in range(1, 13):
            r, col = divmod(m - 1, 4)
            x = CX0 + 16 + col * (bw + gap)
            y = top - (r + 1) * (bh + gap) + gap
            c.setFillColor(TAB)
            c.roundRect(x, y, bw, bh, 10, stroke=0, fill=1)
            self.text(x + 14, y + bh - 24, calendar.month_name[m], 14, "Helvetica-Bold")
            wk = self.week_of[dt.date(self.year, m, 1)]
            self.text(x + 14, y + 12, f"from week {wk}", 9.5, color=MUTED)
            self.link(f"m{m}", x, y, x + bw, y + bh)
        # sections
        sx = CX0 + 4 * bw + 3 * gap + 32 + 20
        sections = [("Year at a glance", "year", INK, "All 12 months on one page"),
                    ("Goals", "goals", INK, "What this year is for"),
                    ("Lesson plans", "lessons", LESSON, f"{N_LESSONS} lesson-plan pages"),
                    ("Student tracker", "students", OTHER, "Students, levels, schedules"),
                    ("Study plans", "study", STUDY, f"{N_STUDY} plans with topic checklists"),
                    ("Notes", "notes", MUTED, f"{N_NOTES} dot-grid pages")]
        y = y0
        for label, key, col, desc in sections:
            y -= 60
            self.box(sx, y, CX1 - sx, 52)
            c.setFillColor(col)
            c.circle(sx + 20, y + 26, 5, stroke=0, fill=1)
            self.text(sx + 36, y + 29, label, 14, "Helvetica-Bold")
            self.text(sx + 36, y + 13, desc, 10, color=MUTED)
            self.link(key, sx, y, CX1, y + 52)
            y -= 8
        # tips
        tips = ["Write with Apple Pencil; tap links with your finger.",
                "Month tabs on the right are on every page.",
                "On a month page, tap a date to open that day, or a week number for the week.",
                "Day and week headings link back up to their week and month.",
                "GoodNotes: import as a PDF file (not an image) so links keep working."]
        tb = CY0
        th = 26 + len(tips) * 22
        t = self.box(CX0, tb, CX1 - CX0, th, "Using it with Apple Pencil", INK)
        for i, s in enumerate(tips):
            self.text(CX0 + 20, t - 6 - i * 22, "•  " + s, 11.5)
        self.finish()

    def mini_month(self, x, y, w, h, m):
        """Small linked calendar; (x, y) is the bottom-left corner."""
        c = self.c
        self.box(x, y, w, h)
        name = calendar.month_name[m]
        self.text(x + 14, y + h - 26, name, 14, "Helvetica-Bold")
        self.link(f"m{m}", x + 10, y + h - 32, x + 14 + c.stringWidth(name, "Helvetica-Bold", 14) + 4, y + h - 10)
        cw = (w - 24) / 7
        gy = y + h - 48
        for i, d in enumerate(self.dow):
            self.text(x + 12 + cw * i + cw / 2, gy, d[0], 9, "Helvetica-Bold", MUTED, "center")
        rh = (gy - y - 10) / 6
        weeks = [wk for wk in self.weeks if any(d.month == m and d.year == self.year for d in wk)]
        for r, wk in enumerate(weeks):
            for i, d in enumerate(wk):
                if d.month != m or d.year != self.year:
                    continue
                cx = x + 12 + cw * i
                cy = gy - (r + 1) * rh
                self.text(cx + cw / 2, cy + rh / 2 - 6, str(d.day), 10.5, color=INK)
                self.link(f"d{d.isoformat()}", cx, cy, cx + cw, cy + rh)

    def year_page(self):
        self.new_page("year", section="year", outline="Year at a glance")
        self.header(f"{self.year} at a glance", [("Index", "index")])
        cols, rows, g = 4, 3, 12
        w = (CX1 - CX0 - g * (cols - 1)) / cols
        h = (CY1 - 12 - CY0 - g * (rows - 1)) / rows
        for m in range(1, 13):
            r, col = divmod(m - 1, cols)
            self.mini_month(CX0 + col * (w + g), CY1 - 12 - (r + 1) * h - r * g, w, h, m)
        self.finish()

    def goals_page(self):
        self.new_page("goals", section="goals", outline="Goals")
        self.header(f"{self.year} goals", [("Index", "index"), (str(self.year), "year")])
        g = 14
        w = (CX1 - CX0 - g) / 2
        h = (CY1 - 12 - CY0 - g) / 2
        areas = [("Teaching", LESSON), ("Learning & study", STUDY),
                 ("Personal", OTHER), ("Habits & wellbeing", MUTED)]
        for i, (t, col) in enumerate(areas):
            r, cc = divmod(i, 2)
            x = CX0 + cc * (w + g)
            y = CY1 - 12 - (r + 1) * h - r * g
            top = self.box(x, y, w, h, t, col)
            self.lines(x + 16, x + w - 16, top, y + 14, 28, checks=True)
        self.finish()

    def month_page(self, m):
        c = self.c
        name = calendar.month_name[m]
        first = dt.date(self.year, m, 1)
        prev = f"m{m - 1}" if m > 1 else None
        nxt = f"m{m + 1}" if m < 12 else None
        self.new_page(f"m{m}", month=m, outline=name)
        self.header(name, [(str(self.year), "year")],
                    sub=f"{calendar.monthrange(self.year, m)[1]} days", prev=prev, nxt=nxt)
        weeks = [wk for wk in self.weeks if any(d.month == m and d.year == self.year for d in wk)]
        gx0, gx1 = CX0 + 34, CX0 + 650
        cw = (gx1 - gx0) / 7
        top = CY1 - 10
        self.text(CX0 + 14, top - 16, "WK", 9, "Helvetica-Bold", MUTED, "center")
        for i, d in enumerate(self.dow):
            self.text(gx0 + cw * i + 8, top - 16, d.upper(), 9.5, "Helvetica-Bold", MUTED)
        gtop = top - 26
        rh = (gtop - CY0) / len(weeks)
        for r, wk in enumerate(weeks):
            y = gtop - (r + 1) * rh
            n = self.week_of[wk[0]]
            self.pill(CX0, y + rh - 26, str(n), f"w{n}", w=28, h=20)
            for i, d in enumerate(wk):
                x = gx0 + cw * i
                inside = d.month == m and d.year == self.year
                c.setStrokeColor(LINE)
                c.setFillColor(PAPER if inside else SHADE)
                c.rect(x, y, cw, rh, stroke=1, fill=1)
                if inside:
                    self.text(x + 8, y + rh - 18, str(d.day), 13, "Helvetica-Bold")
                    self.link(f"d{d.isoformat()}", x, y + rh - 26, x + 34, y + rh)
        # side panel
        sx = gx1 + 18
        sw = CX1 - sx
        hh = (CY1 - 10 - CY0 - 24) / 3
        y = CY1 - 10 - hh
        for t, col, ruled in [("Monthly focus", INK, True), ("Important dates", OTHER, True),
                              ("Notes", MUTED, False)]:
            t_top = self.box(sx, y, sw, hh, t, col)
            if ruled:
                self.lines(sx + 14, sx + sw - 14, t_top, y + 10, 26)
            else:
                self.dots(sx + 14, y + 12, sx + sw - 14, t_top - 4)
            y -= hh + 12
        self.finish()

    def week_page(self, n):
        wk = self.weeks[n - 1]
        a, b = wk[0], wk[-1]
        months = []
        for d in wk:
            if d.year == self.year and d.month not in months:
                months.append(d.month)
        crumbs = [(str(self.year), "year")] + [(calendar.month_name[m], f"m{m}") for m in months]
        rng = f"{a:%b} {a.day} – {b:%b} {b.day}"
        self.new_page(f"w{n}", month=months[0], outline=f"Week {n}  ({rng})", level=1)
        self.header(f"Week {n}", crumbs, sub=rng,
                    prev=f"w{n - 1}" if n > 1 else None,
                    nxt=f"w{n + 1}" if n < len(self.weeks) else None)
        g = 10
        w = (CX1 - CX0 - 3 * g) / 4
        h = (CY1 - 10 - CY0 - g) / 2
        for i in range(8):
            r, col = divmod(i, 4)
            x = CX0 + col * (w + g)
            y = CY1 - 10 - (r + 1) * h - r * g
            if i == 7:
                top = self.box(x, y, w, h, "Week priorities", INK, fill=SHADE)
                self.lines(x + 14, x + w - 14, top, y + 12, 26, checks=True)
                continue
            d = wk[i]
            inside = d.year == self.year
            self.box(x, y, w, h, fill=None if inside else SHADE)
            self.text(x + 14, y + h - 24, self.dow[i].upper(), 10, "Helvetica-Bold", MUTED)
            self.text(x + 14 + 34, y + h - 25, f"{d:%b} {d.day}", 14, "Helvetica-Bold",
                      INK if inside else MUTED)
            if inside:
                self.link(f"d{d.isoformat()}", x, y + h - 36, x + w, y + h)
                self.text(x + w - 14, y + h - 24, "open ›", 9, "Helvetica-Bold", MUTED, "right")
            self.lines(x + 14, x + w - 14, y + h - 34, y + 12, 26)
        self.finish()

    def day_page(self, d):
        c = self.c
        key = f"d{d.isoformat()}"
        n = self.week_of[d]
        one = dt.timedelta(days=1)
        prev = f"d{(d - one).isoformat()}" if (d - one).year == self.year else None
        nxt = f"d{(d + one).isoformat()}" if (d + one).year == self.year else None
        self.new_page(key, month=d.month)
        self.header(f"{calendar.day_name[d.weekday()]}, {calendar.month_name[d.month]} {d.day}",
                    [(str(self.year), "year"), (calendar.month_name[d.month], f"m{d.month}"),
                     (f"Week {n}", f"w{n}")],
                    sub=f"Day {d.timetuple().tm_yday}", prev=prev, nxt=nxt)
        top = CY1 - 10
        # schedule
        lw = 420
        t = self.box(CX0, CY0, lw, top - CY0, "Schedule", INK)
        hours = list(range(6, 22))
        rh = (t - CY0 - 10) / len(hours)
        for i, hr in enumerate(hours):
            y = t - i * rh
            c.setStrokeColor(LINE)
            c.setLineWidth(0.8)
            c.line(CX0 + 54, y, CX0 + lw - 14, y)
            c.setDash(2, 3)
            c.line(CX0 + 54, y - rh / 2, CX0 + lw - 14, y - rh / 2)
            c.setDash()
            label = f"{hr % 12 or 12}{'am' if hr < 12 else 'pm'}"
            self.text(CX0 + 44, y - 12, label, 9.5, "Helvetica-Bold", MUTED, "right")
        # right column
        rx = CX0 + lw + 14
        rw = CX1 - rx
        th = 118
        tt = self.box(rx, top - th, rw, th, "Top 3", OTHER)
        for i in range(3):
            y = tt - 26 * (i + 1) + 4
            self.text(rx + 18, y + 3, str(i + 1), 11, "Helvetica-Bold", OTHER)
            c.setStrokeColor(LINE)
            c.line(rx + 34, y, rx + rw - 14, y)
        mh = 214
        my = top - th - 12 - mh
        hw = (rw - 12) / 2
        t1 = self.box(rx, my, hw, mh, "To do", INK)
        self.lines(rx + 14, rx + hw - 14, t1, my + 10, 26, checks=True)
        t2 = self.box(rx + hw + 12, my, hw, mh, "Lessons & study", LESSON)
        self.lines(rx + hw + 26, rx + rw - 14, t2, my + 10, 26, checks=True)
        nt = self.box(rx, CY0, rw, my - 12 - CY0, "Notes", MUTED)
        self.dots(rx + 14, CY0 + 12, rx + rw - 14, nt - 4)
        self.finish()

    def list_index(self, key, title, prefix, count, color, outline, hint):
        self.new_page(key, section=key, outline=outline)
        self.header(title, [("Index", "index")], sub=hint, color=color)
        cols = 2
        per = (count + cols - 1) // cols
        g = 14
        w = (CX1 - CX0 - g) / cols
        rh = (CY1 - 12 - CY0) / per
        for i in range(count):
            col, r = divmod(i, per)
            x = CX0 + col * (w + g)
            y = CY1 - 12 - (r + 1) * rh
            self.pill(x, y + rh / 2 - 10, f"{i + 1}", f"{prefix}{i + 1}", w=36, h=20,
                      fill=TAB, ink=color)
            self.c.setStrokeColor(LINE)
            self.c.line(x + 46, y + rh / 2 - 6, x + w, y + rh / 2 - 6)
        self.finish()

    def field_row(self, x, y, fields, total):
        """Labelled write-in fields on one line: fields = [(label, weight)]."""
        tw = sum(wt for _, wt in fields)
        for label, wt in fields:
            fw = total * wt / tw
            self.text(x, y + 4, label.upper(), 9, "Helvetica-Bold", MUTED)
            lx = x + self.c.stringWidth(label.upper(), "Helvetica-Bold", 9) + 8
            self.c.setStrokeColor(LINE)
            self.c.line(lx, y, x + fw - 16, y)
            x += fw

    def lesson_page(self, i):
        self.new_page(f"lesson{i}", section="lessons")
        self.header(f"Lesson plan {i}", [("Index", "index"), ("Lesson plans", "lessons")],
                    prev=f"lesson{i - 1}" if i > 1 else None,
                    nxt=f"lesson{i + 1}" if i < N_LESSONS else None, color=LESSON)
        top = CY1 - 26
        self.field_row(CX0, top, [("Student / class", 3), ("Date", 1.4), ("Lesson #", 1),
                                  ("Level", 1.2)], CX1 - CX0)
        top -= 18
        g = 12
        w = (CX1 - CX0 - 2 * g) / 3
        colspec = [
            [("From last class", LESSON, 0.5, True), ("Objectives", LESSON, 0.5, True)],
            [("Warm-up & review", INK, 0.32, False), ("Main activities", INK, 0.68, False)],
            [("Homework", STUDY, 0.3, True), ("Next steps", OTHER, 0.3, True), ("Notes", MUTED, 0.4, None)],
        ]
        avail = top - CY0
        for ci, boxes in enumerate(colspec):
            x = CX0 + ci * (w + g)
            y = top
            gaps = g * (len(boxes) - 1)
            for t, col, frac, checks in boxes:
                h = (avail - gaps) * frac
                y -= h
                tt = self.box(x, y, w, h, t, col)
                if checks is None:
                    self.dots(x + 14, y + 12, x + w - 14, tt - 4)
                else:
                    self.lines(x + 14, x + w - 14, tt, y + 10, 26, checks=checks)
                y -= g
        self.finish()

    def student_page(self, i):
        key = "students" if i == 1 else f"students{i}"
        self.new_page(key, section="students", outline="Student tracker" if i == 1 else None)
        self.header("Student tracker", [("Index", "index")], sub=f"Page {i} of {N_STUDENT_PAGES}",
                    prev=("students" if i == 2 else f"students{i - 1}") if i > 1 else None,
                    nxt=f"students{i + 1}" if i < N_STUDENT_PAGES else None, color=OTHER)
        c = self.c
        cols = [("Name", 1.5), ("Level / group", 1), ("Contact", 1.3), ("Day & time", 1.1),
                ("Goals", 2), ("Notes", 2)]
        tw = sum(w for _, w in cols)
        top = CY1 - 12
        self.box(CX0, CY0, CX1 - CX0, top - CY0, fill=None)
        hh = 30
        c.setFillColor(OTHER_SOFT)
        c.roundRect(CX0, top - hh, CX1 - CX0, hh, 10, stroke=0, fill=1)
        c.rect(CX0, top - hh, CX1 - CX0, hh / 2, stroke=0, fill=1)
        x = CX0
        xs = []
        for label, wt in cols:
            self.text(x + 12, top - 19, label.upper(), 9.5, "Helvetica-Bold", OTHER)
            xs.append(x)
            x += (CX1 - CX0) * wt / tw
        rows = 12
        rh = (top - hh - CY0) / rows
        c.setStrokeColor(LINE)
        for r in range(1, rows):
            y = top - hh - r * rh
            c.line(CX0, y, CX1, y)
        for x in xs[1:]:
            c.line(x, CY0, x, top)
        self.finish()

    def study_page(self, i):
        self.new_page(f"study{i}", section="study")
        self.header(f"Study plan {i}", [("Index", "index"), ("Study plans", "study")],
                    prev=f"study{i - 1}" if i > 1 else None,
                    nxt=f"study{i + 1}" if i < N_STUDY else None, color=STUDY)
        c = self.c
        top = CY1 - 26
        self.field_row(CX0, top, [("Subject", 2), ("Goal", 3), ("Target date", 1.4)], CX1 - CX0)
        top -= 18
        lw = 340
        tt = self.box(CX0, CY0, lw, top - CY0, "Topics", STUDY)
        self.lines(CX0 + 14, CX0 + lw - 14, tt, CY0 + 12, 28, checks=True)
        rx = CX0 + lw + 14
        rw = CX1 - rx
        lt = self.box(rx, CY0, rw, top - CY0, "Session log", STUDY)
        cols = [("Date", 1), ("Topics covered", 3), ("Time", 0.8), ("Done", 0.6)]
        tw = sum(w for _, w in cols)
        x = rx + 14
        xs = []
        for label, wt in cols:
            self.text(x + 4, lt - 4, label.upper(), 8.5, "Helvetica-Bold", MUTED)
            xs.append(x)
            x += (rw - 28) * wt / tw
        ytop = lt - 12
        c.setStrokeColor(LINE)
        self.lines(rx + 14, rx + rw - 14, ytop + 28, CY0 + 12, 28)
        for x in xs[1:]:
            c.line(x, CY0 + 12, x, ytop)
        self.finish()

    def note_page(self, i):
        self.new_page(f"note{i}", section="notes")
        self.header(f"Notes {i}", [("Index", "index"), ("Notes", "notes")],
                    prev=f"note{i - 1}" if i > 1 else None,
                    nxt=f"note{i + 1}" if i < N_NOTES else None)
        top = CY1 - 26
        self.field_row(CX0, top, [("Title", 4), ("Date", 1)], CX1 - CX0)
        self.dots(CX0, CY0, CX1, top - 22)
        self.finish()

    def build(self):
        self.cover()
        self.index()
        self.year_page()
        self.goals_page()
        for m in range(1, 13):
            self.month_page(m)
        for n in range(1, len(self.weeks) + 1):
            self.week_page(n)
        d = dt.date(self.year, 1, 1)
        while d.year == self.year:
            self.day_page(d)
            d += dt.timedelta(days=1)
        self.list_index("lessons", "Lesson plans", "lesson", N_LESSONS, LESSON, "Lesson plans",
                        "Write the student's name next to a number, then tap it")
        for i in range(1, N_LESSONS + 1):
            self.lesson_page(i)
        for i in range(1, N_STUDENT_PAGES + 1):
            self.student_page(i)
        self.list_index("study", "Study plans", "study", N_STUDY, STUDY, "Study plans",
                        "Name each plan, then tap its number")
        for i in range(1, N_STUDY + 1):
            self.study_page(i)
        self.list_index("notes", "Notes", "note", N_NOTES, MUTED, "Notes",
                        "Give each page a title, then tap its number")
        for i in range(1, N_NOTES + 1):
            self.note_page(i)
        self.c.save()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--year", type=int, default=dt.date.today().year + 1)
    p.add_argument("--week-start", choices=["monday", "sunday"], default="monday")
    p.add_argument("--out", help="output PDF path")
    a = p.parse_args()
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                f"Pencil-Planner-{a.year}.pdf")
    Planner(a.year, out, 0 if a.week_start == "monday" else 6).build()
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
