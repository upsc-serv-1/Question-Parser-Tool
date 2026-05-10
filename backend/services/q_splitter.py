"""Question splitter & QP↔SOL matcher."""
from __future__ import annotations
import re
from typing import List, Dict, Optional

# Matches "Q.1)", "Q. 1.", "Q1)", "Q 1)", "Question 1." — REQUIRES the "Q" prefix at line start.
# This is intentionally strict to avoid catching article numbers, list items, etc. UPSC coaching
# PDFs almost universally prefix questions with `Q.N)` or `Q. N.` style, so requiring the prefix
# is dramatically more precise than allowing bare numbers.
Q_HEADING_RE = re.compile(
    r"^\s*(?:Q(?:uestion)?\.?\s*)(\d{1,3})\s*[\.\)]\s*",
    re.MULTILINE | re.IGNORECASE,
)


def split_questions(text: str) -> List[Dict]:
    """Split a chunk of text into question blocks indexed by question number.

    Returns list of {"number": int, "text": str} sorted by number.
    Duplicate numbers keep the longest block.
    """
    if not text:
        return []
    matches = list(Q_HEADING_RE.finditer(text))
    if not matches:
        return []
    blocks: Dict[int, str] = {}
    for i, m in enumerate(matches):
        try:
            num = int(m.group(1))
        except ValueError:
            continue
        # Skip ridiculously large numbers (likely option counters or refs)
        if num < 1 or num > 999:
            continue
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        # Only keep if previously empty, or this body is longer
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
