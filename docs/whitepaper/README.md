# Whitepaper

`whitepaper.tex` -> `whitepaper.pdf` (7 pages, A4). Plain-language but complete
account of the three layers, with every number measured and every limit named.

Build:

```bash
pdflatex whitepaper.tex && pdflatex whitepaper.tex   # twice for the table of contents
```

Needs a base TeX Live install (`pdflatex`); no exotic packages.
