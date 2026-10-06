#!/usr/bin/env python3
"""Compose the deck: presentation-builder template + our slides + live module.

    python3 build.py            → dist/deck.html

template.html (a generic presentation template) is never edited. This script
splits it, drops parts/slides.html into the deck container, injects
parts/live.css and parts/{deck,live}.js, and inlines demo.config.json.

- There is no backend and no API key. The deck talks to Synerise straight
  from the browser with the *tracker key* (the public key from the tracking
  code), exactly as a VTEX storefront would.
- The Synerise JS SDK is part of the page: the tracking code goes into <head>,
  so the deck has an anonymous profile (UUID) of its own and sends
  item.search.click / recommendation.view / recommendation.click events.

The template's PDF export is stripped: half of this deck is a
live application, and a flat page of screenshots is not a useful artefact of it.
"""
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
TEMPLATE = HERE / "template.html"
PARTS = HERE / "parts"
OUT = HERE / "dist" / "deck.html"
TITLE = "VTEX × Synerise — one catalog, every store, every language"

PDF_CHUNKS = [
    """  <span class="nav-divider"></span>
  <button class="pdf-btn" id="pdfBtn" aria-label="Download presentation as PDF">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
    <span id="pdfBtnLabel">Download PDF</span>
  </button>
""",
    '<script src="https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.8/dist/html2canvas-pro.min.js"></script>\n',
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>\n',
    "  const pdfBtn   = document.getElementById('pdfBtn');\n",
    "  const pdfLabel = document.getElementById('pdfBtnLabel');\n",
]
PDF_SPAN = ("  function formatExportDate() {", "  pdfBtn.addEventListener('click', exportToPDF);\n")

# The tracking code exactly as Synerise hands it out (Settings → Tracking codes),
# with two additions: disableDynamicContent, because the workspace's own
# Dynamic Content layers would otherwise pop up over the slides, and
# onSyneriseLoad telling the live module the SDK is up.
SDK_SNIPPET = """<script>
  function onSyneriseLoad() {
      SR.init({
        trackerKey: "%(trackerKey)s",
        disableWebPush: true,
        disableDynamicContent: true
      });
      window.dispatchEvent(new Event('synerise:ready'));
  }

  (function(s,y,n,e,r,i,se){s["SyneriseObjectNamespace"]=r;s[r]=s[r]||[],
   s[r]._t=1*new Date(),s[r]._i=0,s[r]._l=i;var z=y.createElement(n),
   se=y.getElementsByTagName(n)[0];z.async=1;z.src=e;se.parentNode.insertBefore(z,se);
   z.onload=z.onreadystatechange=function(){var rdy=z.readyState;
   if(!rdy||/complete|loaded/.test(z.readyState)){s[i]();z.onload = null;
   z.onreadystatechange=null;}};})(window,document,"script", "%(sdkUrl)s", "SR", "onSyneriseLoad");
</script>
"""


def strip_pdf_export(tail: str) -> str:
    for chunk in PDF_CHUNKS:
        if chunk not in tail:
            raise SystemExit(f"PDF chunk not found in template, cannot strip:\n{chunk[:80]}…")
        tail = tail.replace(chunk, "", 1)
    start, end = PDF_SPAN
    i, j = tail.find(start), tail.find(end)
    if i < 0 or j < i:
        raise SystemExit("PDF export function span not found in template")
    return tail[:i] + tail[j + len(end):]


def main() -> int:
    config = json.loads((HERE / "demo.config.json").read_text(encoding="utf-8"))
    tpl = TEMPLATE.read_text(encoding="utf-8")
    slides = (PARTS / "slides.html").read_text(encoding="utf-8")
    live_css = (PARTS / "live.css").read_text(encoding="utf-8")
    deck_js = (PARTS / "deck.js").read_text(encoding="utf-8")
    live_js = (PARTS / "live.js").read_text(encoding="utf-8")

    logo = re.search(r'<svg class="logo-mark".*?</svg>', tpl, re.S)
    if not logo:
        print("logo-mark svg not found in template", file=sys.stderr)
        return 1
    chrome = ('<div class="slide-chrome"><div class="slide-chrome-tl">'
              f'{logo.group(0)}<span class="chrome-crumb">VTEX × Synerise · feed architecture</span>'
              '</div><div class="slide-chrome-tr">{{SECTION}}</div></div>')
    # {{CHROME:Section label}} → chrome with that label top-right.
    slides = re.sub(r"\{\{CHROME:([^}]*)\}\}", lambda m: chrome.replace("{{SECTION}}", m.group(1)), slides)
    slides = slides.replace("{{LOGO}}", logo.group(0))

    n_slides = len(re.findall(r'<section class="slide[ "]', slides))
    counter = iter(range(1, n_slides + 1))
    slides = re.sub(r"\{\{N\}\}", lambda _: f"{next(counter):02d}", slides)
    slides = slides.replace("{{TOTAL}}", f"{n_slides:02d}")
    leftover = re.findall(r"\{\{[A-Z:]+[^}]*\}\}", slides)
    if leftover:
        print(f"unresolved placeholders in parts/slides.html: {sorted(set(leftover))}", file=sys.stderr)
        return 1

    head, rest = tpl.split("<body>", 1)
    _, tail = rest.split("<!-- NAVIGATION -->", 1)
    tail = "<!-- NAVIGATION -->" + tail

    head = re.sub(r"<title>.*?</title>", f"<title>{TITLE}</title>", head, count=1, flags=re.S)
    head = head.replace("</head>", f"<style>\n{live_css}\n</style>\n"
                        + SDK_SNIPPET % config + "</head>")

    tail = strip_pdf_export(tail)
    data = f"<script>\nwindow.__DEMO_CONFIG__ = {json.dumps(config, ensure_ascii=False)};\n</script>\n"
    tail = tail.replace("</body>", data + f"<script>\n{deck_js}\n</script>\n"
                                        f"<script>\n{live_js}\n</script>\n</body>")

    deck = head + "<body>\n\n<div class=\"deck\" id=\"deck\">\n" + slides + "\n</div>\n\n" + tail
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(deck, encoding="utf-8")
    print(f"built {OUT.relative_to(HERE)} — {len(deck) / 1024:.0f} KB, {n_slides} slides")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
