#!/usr/bin/env bash
# Rebuild both PDFs. The report is assembled from four parts so that sections
# stay editable in isolation; report.tex is generated, not source.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 ../make_tables.py > /dev/null   # regenerate tables from artifacts/results.json
cat report_part1.tex report_part2.tex report_part3.tex report_part4.tex > report.tex
pdflatex -interaction=nonstopmode report.tex > /dev/null
pdflatex -interaction=nonstopmode report.tex > /dev/null   # second pass for the ToC
pdflatex -interaction=nonstopmode abstract.tex > /dev/null
rm -f *.aux *.log *.out *.toc
echo "built: docs/report.pdf  docs/abstract.pdf"
