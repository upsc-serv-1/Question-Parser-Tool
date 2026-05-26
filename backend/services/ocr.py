"""Optical Character Recognition (OCR) handler via Pytesseract & Apple Vision."""
from __future__ import annotations
import shutil
import io
import os
import sys
import subprocess
import re
import fitz

def is_tesseract_available() -> bool:
    """Check if the tesseract binary is installed and accessible in PATH."""
    return shutil.which("tesseract") is not None

def is_mac_ocr_available() -> bool:
    """Check if the compiled native macOS Vision OCR binary is available."""
    binary_path = os.path.join(os.path.dirname(__file__), "mac_ocr")
    return sys.platform == "darwin" and os.path.exists(binary_path)

def ocr_page_via_mac_ocr(pdf_path: str, page_num: int, columns: int = 1) -> str:
    """Run native Apple Vision OCR on a specific PDF page (1-based index).
    If columns > 1, geometrically slices and sorts the output into vertical columns.
    """
    binary_path = os.path.join(os.path.dirname(__file__), "mac_ocr")
    cmd = [binary_path, pdf_path, str(page_num)]
    
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        raw_output = res.stdout
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Native macOS OCR failed: {e.stderr or e}")
        
    # Parse lines with coordinates [x, y, w, h] text_string
    lines = []
    pattern = re.compile(r'^\[([0-9\.]+),\s*([0-9\.]+),\s*([0-9\.]+),\s*([0-9\.]+)\]\s*(.*)$')
    for line in raw_output.splitlines():
        m = pattern.match(line)
        if m:
            x, y, w, h = map(float, m.groups()[:4])
            text = m.group(5).strip()
            
            # Watermark / Noise filtering
            text_lower = text.lower()
            if 'prepp' in text_lower or 'www.' in text_lower or 'exams guide' in text_lower:
                continue
            if re.match(r'^[A-D]\s*-\s*[A-Z0-9\-]+$', text): # Series code like 'A - TDSP-O-GMPK'
                continue
            if text.isdigit() and y < 0.08: # Page numbers at bottom
                continue
                
            lines.append({'x': x, 'y': y, 'w': w, 'h': h, 'text': text})
            
    if not lines:
        return ""
        
    if columns <= 1:
        # Sort top-to-bottom (y is from bottom to top in Vision, so descending)
        lines.sort(key=lambda item: item['y'], reverse=True)
        return "\n".join(item['text'] for item in lines)
        
    # Two-column layout sorting
    col1 = []
    col2 = []
    for item in lines:
        cx = item['x'] + item['w'] / 2
        if cx < 0.5:
            col1.append(item)
        else:
            col2.append(item)
            
    col1.sort(key=lambda item: item['y'], reverse=True)
    col2.sort(key=lambda item: item['y'], reverse=True)
    
    text_col1 = "\n".join(item['text'] for item in col1)
    text_col2 = "\n".join(item['text'] for item in col2)
    
    return text_col1 + "\n\n" + text_col2

def ocr_page_via_tesseract(page: fitz.Page, dpi: int = 300, lang: str = "eng") -> str:
    """Render page to high-DPI pixmap and feed to pytesseract OCR."""
    if not is_tesseract_available():
        raise RuntimeError(
            "Tesseract OCR engine not detected on the system. "
            "Please install Tesseract-OCR for Windows/Linux and ensure 'tesseract' is in PATH."
        )
    from PIL import Image
    import pytesseract
    
    # Render to high resolution to maximize accuracy
    pix = page.get_pixmap(dpi=dpi)
    img_data = pix.tobytes("png")
    
    pil_img = Image.open(io.BytesIO(img_data))
    text = pytesseract.image_to_string(pil_img, lang=lang)
    return text or ""

