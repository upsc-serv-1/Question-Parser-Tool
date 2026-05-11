"""PDF text extraction (text-based via PyMuPDF; OCR fallback noted for Phase 2)."""
from __future__ import annotations
import fitz  # PyMuPDF
from pathlib import Path
from typing import List, Dict
import re


def extract_pages(pdf_path: str, use_ocr: bool = False, columns: int = 1) -> List[Dict]:
    """Return list of {page_num, text, char_count} for each page.
    
    If columns > 1, geometrically slices page horizontally and reorders blocks top-down
    by column to maintain reading order.
    """
    doc = fitz.open(pdf_path)
    pages = []
    
    # Import OCR if needed
    from .ocr import ocr_page_via_tesseract, is_tesseract_available

    for i, page in enumerate(doc):
        raw_text = ""
        
        if use_ocr:
            # Forced OCR path
            raw_text = ocr_page_via_tesseract(page)
        else:
            # Intelligent Text Path
            if columns <= 1:
                raw_text = page.get_text("text") or ""
            else:
                # Slice into logical vertical segments
                blocks = page.get_text("blocks") # (x0, y0, x1, y1, "text", block_no, type)
                width = page.rect.width
                col_width = width / columns
                
                # Group blocks into columnar bins
                buckets = [[] for _ in range(columns)]
                for b in blocks:
                    # Find bucket based on center X coord of block
                    cx = (b[0] + b[2]) / 2
                    bucket_idx = int(cx // col_width)
                    bucket_idx = max(0, min(bucket_idx, columns - 1))
                    buckets[bucket_idx].append(b)
                
                # Combine texts bucket by bucket, sorting each by vertical Y ascending
                page_parts = []
                for buck in buckets:
                    buck.sort(key=lambda item: item[1]) # sort by top-Y
                    col_text = "\n".join(b[4] for b in buck if isinstance(b[4], str))
                    page_parts.append(col_text)
                
                raw_text = "\n".join(page_parts)
        
        pages.append({
            "page_num": i + 1,
            "text": raw_text,
            "char_count": len(raw_text.strip()),
        })
    
    doc.close()
    return pages


def is_scanned(pages: List[Dict], threshold: int = 50) -> bool:
    """Heuristic: if average char count per page < threshold, likely scanned."""
    if not pages:
        return False
    avg = sum(p["char_count"] for p in pages) / len(pages)
    return avg < threshold


def render_page_png(pdf_path: str, page_num: int, dpi: int = 150) -> bytes:
    """Render a single PDF page as PNG bytes."""
    doc = fitz.open(pdf_path)
    try:
        if page_num < 1 or page_num > len(doc):
            raise IndexError(f"Page {page_num} out of range (1..{len(doc)})")
        page = doc[page_num - 1]
        pix = page.get_pixmap(dpi=dpi)
        return pix.tobytes("png")
    finally:
        doc.close()


# Common watermark / header / footer patterns to strip
_NOISE_PATTERNS = [
    r"^\s*Page\s*\d+\s*(of\s*\d+)?\s*$",
    r"^\s*\d+\s*$",  # bare page numbers
    r"DO\s+NOT\s+OPEN\b.*",
    r"www\.[\w\-\.]+\.(com|in|org)\b.*",
    r"©\s*\d{4}.*",
    r"All\s+rights\s+reserved.*",
    r"This\s+booklet\s+contains.*",
]
_NOISE_RE = [re.compile(p, re.IGNORECASE) for p in _NOISE_PATTERNS]


def clean_lines(text: str) -> str:
    """Remove header/footer/watermark-like lines."""
    out_lines = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out_lines.append(line)
            continue
        if any(rx.match(s) for rx in _NOISE_RE):
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


def repeated_line_strip(pages: List[Dict], min_ratio: float = 0.5) -> List[Dict]:
    """Remove lines that appear on more than `min_ratio` of pages (likely watermarks/headers)."""
    if len(pages) < 4:
        return pages
    from collections import Counter
    counter: Counter = Counter()
    for p in pages:
        seen = set()
        for line in (p["text"] or "").splitlines():
            s = line.strip()
            if 4 <= len(s) <= 80 and not re.match(r"^\s*Q\.?\s*\d+", s):
                seen.add(s)
        for s in seen:
            counter[s] += 1
    threshold = max(2, int(len(pages) * min_ratio))
    repeated = {s for s, c in counter.items() if c >= threshold}
    out = []
    for p in pages:
        new_lines = [ln for ln in (p["text"] or "").splitlines() if ln.strip() not in repeated]
        out.append({**p, "text": "\n".join(new_lines)})
    return out


def full_text(pages: List[Dict]) -> str:
    return "\n".join(p["text"] for p in pages)
