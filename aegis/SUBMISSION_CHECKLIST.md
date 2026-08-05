# Submission checklist

Everything below is derived from the preliminary question set. Work through it
before you upload — most disqualifications at this stage are format failures,
not weak ideas.

---

## 1. Rename the two files

Get your registration ID from **itcarnival26.pstu.ac.bd/events/hackathon/teams**
(format `PSTU-HACK-2026-000`), then:

```bash
ID=PSTU-HACK-2026-000        # <-- replace with your actual ID

cp docs/abstract.pdf  "$ID.pdf"
# and after you record and export the video:
cp your_recording.mp4 "$ID.mp4"
```

Or run the helper: `bash rename_for_submission.sh PSTU-HACK-2026-000`

---

## 2. Hard limits — verify, don't assume

| Requirement | Limit | Status |
|---|---|---|
| Abstract format | PDF | ✅ `docs/abstract.pdf` |
| Abstract length | ≤ 250 words | ✅ 237 words |
| Abstract file size | ≤ 10 MB | ✅ ~58 KB |
| Video format | MP4 (`.mp4`) | ⬜ yours to record |
| Video length | ≤ 4 minutes | ⬜ script targets 3:50 |
| Video file size | ≤ 400 MB | ⬜ 1080p H.264 @ 5 Mbps ≈ 150 MB |
| Both files renamed to registration ID | — | ⬜ |
| One submission per team, registered mail only | — | ⬜ |
| Deadline | **6 August 2026, 11:59 PM** | ⬜ |

Check the word count yourself rather than trusting the number above:

```bash
pdftotext docs/abstract.pdf - | wc -w
```

(This counts the title and footer too, so it will read higher than 237. The
body — what a judge would count as the abstract — is 237.)

---

## 3. Anonymity — the easiest way to lose

The rules forbid, in **both** the abstract and the video:

- ⬜ team name
- ⬜ any team member's name
- ⬜ university or institution name

The abstract is already clean. For the video, the failure mode is never the
script — it's the recording environment. Before exporting, watch the whole
file back and check for:

- your name in a file path, terminal prompt, or window title bar
- a browser bookmark bar, open tab, or autofill dropdown
- a Slack / email / calendar notification popping in
- desktop wallpaper, sticky notes, or a visible student ID
- git commit author lines if you show any terminal
- PDF metadata (`pdfinfo` on your exported abstract — check the Author field)

To strip metadata from a PDF if needed:

```bash
qpdf --empty --pages "$ID.pdf" 1-z -- clean.pdf && mv clean.pdf "$ID.pdf"
```

---

## 4. What's in this package

| Path | What it is |
|---|---|
| `docs/abstract.pdf` | **Submission deliverable.** 237 words, 1 page — rename to your ID |
| `docs/report.pdf` | 21-page architecture specification covering all 13 functional expectations |
| `docs/video_script.md` | 4-minute script, timed to 3:50, with slide cues |
| `docs/*.tex` | LaTeX source for both PDFs |
| `docs/tex/` | Auto-generated result tables (from `artifacts/results.json`) |
| `README.md` | Repository guide, results summary, the four bugs |
| `src/aegis/` | Reference implementation (~3,000 lines) |
| `tests/test_all.py` | 36 tests, no dependencies |
| `run_simulation.py` | Evaluation harness |
| `make_tables.py` | Regenerates every table in the report |
| `artifacts/` | Evaluation output: full metrics, comparison, sample decision records |

No source code is required for this qualification round — the code is included
because the report's central claim is that this was built and measured, and a
judge who wants to check that should be able to.

---

## 5. Before you record

Run these once so you can show them working, and so you know the numbers are
real:

```bash
python tests/test_all.py        # expect 36/36
python run_simulation.py        # expect the table in README.md
```

Five seconds of the test suite passing on screen substantiates the whole
submission better than another diagram.

---

## 6. One thing to settle yourself

The question set says nothing about whether AI assistance is permitted. That
is not the same as permitting it. The event coordinators are listed on the last
page of the question set — a short message asking is cheap, and finding out
after the fact is not.

Separately: you will be asked to defend these decisions, on camera and likely
in the next round. The report explains *reasoning* rather than listing
conclusions for exactly that reason. Read it as an argument you need to be able
to make, not a document you need to summarise.
