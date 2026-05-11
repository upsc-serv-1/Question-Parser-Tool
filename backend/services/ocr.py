"""Optical Character Recognition (OCR) handler via Pytesseract."""
from __future__ import annotations
import shutil
import io
from PIL import Image
import pytesseract
import fitz

def is_tesseract_available() -> bool:
    """Check if the tesseract binary is installed and accessible in PATH."""
    return shutil.which("tesseract") is not None

def ocr_page_via_tesseract(page: fitz.Page, dpi: int = 300, lang: str = "eng") -> str:
    """Render page to high-DPI pixmap and feed to pytesseract OCR."""
    if not is_tesseract_available():
        raise RuntimeError(
            "Tesseract OCR engine not detected on the system. "
            "Please install Tesseract-OCR for Windows and ensure 'tesseract.exe' is in your system PATH."
        )
    
    # Render to high resolution to maximize accuracy
    pix = page.get_pixmap(dpi=dpi)
    img_data = pix.tobytes("png")
    
    pil_img = Image.open(io.BytesIO(img_data))
    text = pytesseract.image_to_string(pil_img, lang=lang)
    return text or ""
