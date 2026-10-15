# Intratrade

Static one-screen book for [trading.josyulablog.org](https://trading.josyulablog.org). GitHub Pages serves `index.html` from `main`. `CNAME` stays `trading.josyulablog.org`.

The weekday Action fetches Yahoo Finance at build time and replaces `index.html` only when that fetch returns a live book. A failed feed exits before the file is replaced, so the live site is not overwritten with a sample tape.

Schedule, in UTC, Monday through Friday:

- 12:30
- 16:00
- 20:15

Those are about 8:30 AM, noon, and 4:15 PM US Eastern while daylight saving time is in effect.
