"""Question splitter & QP↔SOL matcher."""
from __future__ import annotations
import re
from typing import List, Dict, Optional

# Matches "Q.1)", "Q. 1.", "Q1)", "Question 1.", or bare "1.", "1)" at the start of a line.
Q_HEADING_RE = re.compile(
    r"^\s*(?:Q(?:uestion)?\.?\s*|)(\d{1,3})\s*[\.\)]\s*",
    re.MULTILINE | re.IGNORECASE,
)


def split_questions(text: str) -> List[Dict]:
    """Split a chunk of text into question blocks indexed by question number.

    Supports sequential bare numbers (e.g. "1. ", "2. ") by filtering out
    non-sequential indices (like sub-statements, e.g. "1. Option one" inside a question).
    """
    if not text:
        return []
    matches = list(Q_HEADING_RE.finditer(text))
    if not matches:
        return []

    # Monotonic sequential filter to prevent statement indices (e.g. 1., 2.) inside
    # question stems from being misidentified as new questions.
    valid_matches = []
    expected = None

    for m in matches:
        try:
            num = int(m.group(1))
        except ValueError:
            continue
        if num < 1 or num > 999:
            continue

        # If it is a clear explicit "Q. N" or "Question N" header, always accept it
        is_explicit_q = "q" in m.group(0).lower() or "question" in m.group(0).lower()
        if is_explicit_q:
            valid_matches.append(m)
            expected = num + 1
            continue

        # For bare numbers (e.g., "1.", "2."), enforce sequence checks
        if expected is None:
            # First question in a paper should start at 1, 2, or 3
            if num <= 5:
                valid_matches.append(m)
                expected = num + 1
        else:
            # Tolerant step: allow skipping up to 5 questions in case OCR missed a number
            if expected <= num <= expected + 5:
                valid_matches.append(m)
                expected = num + 1

    if not valid_matches:
        # Fallback to legacy non-sequential duplicate filtering if no sequential match
        # was formed (to guarantee safety for non-standard formats)
        valid_matches = matches

    blocks: Dict[int, str] = {}
    for i, m in enumerate(valid_matches):
        num = int(m.group(1))
        start = m.start()
        end = valid_matches[i + 1].start() if i + 1 < len(valid_matches) else len(text)
        body = text[start:end].strip()
        # Keep longest block to filter out minor short-form duplicate hits
        if num not in blocks or len(body) > len(blocks[num]):
            blocks[num] = body
            
    return [{"number": n, "text": blocks[n]} for n in sorted(blocks)]


def bundle_qp_sol(qp_blocks: List[Dict], sol_blocks: List[Dict]) -> Dict:
    """Match QP and SOL blocks by question number.

    Returns:
      {
        "items": [{"number": n, "qp_text": str, "sol_text": str|None}, ...],
        "qp_numbers": [...], "sol_numbers": [...],
        "missing_in_qp": [...], "missing_in_sol": [...],
      }
    """
    qp_map = {b["number"]: b["text"] for b in qp_blocks}
    sol_map = {b["number"]: b["text"] for b in sol_blocks}
    qp_nums = sorted(qp_map)
    sol_nums = sorted(sol_map)
    all_nums = sorted(set(qp_nums) | set(sol_nums))
    items = []
    for n in all_nums:
        items.append({
            "number": n,
            "qp_text": qp_map.get(n, ""),
            "sol_text": sol_map.get(n),
        })
    return {
        "items": items,
        "qp_numbers": qp_nums,
        "sol_numbers": sol_nums,
        "missing_in_qp": sorted(set(sol_nums) - set(qp_nums)),
        "missing_in_sol": sorted(set(qp_nums) - set(sol_nums)) if sol_nums else [],
        "total_qp": len(qp_nums),
        "total_sol": len(sol_nums),
    }


def chunk_into_batches(items: List[Dict], batch_size: int = 35) -> List[List[Dict]]:
    """Split list of items into batches."""
    if batch_size < 1:
        batch_size = 35
    out = []
    for i in range(0, len(items), batch_size):
        out.append(items[i:i + batch_size])
    return out
