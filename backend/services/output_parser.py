"""Parser for Gemini's marker-based output."""
from __future__ import annotations
import re
from typing import List, Dict, Tuple, Optional


# Match the question header
Q_HEADER_RE = re.compile(r"^===\s*QUESTION\s+(\d+)\s*===\s*$", re.MULTILINE)
MARKER_RE = re.compile(r"^\[([A-Za-z]+):\s*(.*?)\]\s*$", re.MULTILINE)
SECTION_RE = re.compile(
    r"^---\s*(STATEMENT LINES|OPTIONS|CORRECT ANSWER|EXPLANATION)\s*---\s*$",
    re.MULTILINE,
)
OPTION_LINE_RE = re.compile(r"^\s*([a-dA-D])\s*[\)\.\:]\s*(.+?)\s*$")


def _split_blocks(text: str) -> List[Tuple[int, str]]:
    """Yield (question_number, block_text) for each `=== QUESTION N ===` block."""
    out = []
    matches = list(Q_HEADER_RE.finditer(text))
    if not matches:
        return out
    for i, m in enumerate(matches):
        n = int(m.group(1))
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out.append((n, text[start:end].strip()))
    return out


def _parse_markers(block: str) -> Dict[str, str]:
    out = {}
    for m in MARKER_RE.finditer(block):
        out[m.group(1).lower()] = m.group(2).strip()
    return out


def _parse_sections(block: str) -> Dict[str, str]:
    sections: Dict[str, str] = {}
    matches = list(SECTION_RE.finditer(block))
    for i, m in enumerate(matches):
        name = m.group(1).strip().upper()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(block)
        sections[name] = block[start:end].strip()
    return sections


def parse_options(text: str) -> Dict[str, str]:
    options: Dict[str, str] = {}
    current_letter = None
    buf: List[str] = []
    for line in text.splitlines():
        m = OPTION_LINE_RE.match(line)
        if m:
            if current_letter is not None:
                options[current_letter] = " ".join(buf).strip()
            current_letter = m.group(1).lower()
            buf = [m.group(2)]
        else:
            if current_letter is not None and line.strip():
                buf.append(line.strip())
    if current_letter is not None:
        options[current_letter] = " ".join(buf).strip()
    return options


def parse_output(text: str) -> Dict:
    """Parse full Gemini output text. Returns {questions: [...], errors: [...], skipped: [...]}."""
    questions = []
    errors = []
    skipped = []
    for n, block in _split_blocks(text):
        # SKIP marker
        if "[SKIPPED:" in block.upper():
            skipped.append({"number": n, "reason": block.strip()})
            continue
        markers = _parse_markers(block)
        sections = _parse_sections(block)
        # Validate required pieces
        missing = []
        if "STATEMENT LINES" not in sections:
            missing.append("STATEMENT LINES")
        if "OPTIONS" not in sections:
            missing.append("OPTIONS")
        if "CORRECT ANSWER" not in sections:
            missing.append("CORRECT ANSWER")
        if "EXPLANATION" not in sections:
            missing.append("EXPLANATION")
        if missing:
            errors.append({"number": n, "error": f"Missing sections: {', '.join(missing)}"})
            continue
        statement_lines = [
            ln.strip() for ln in sections["STATEMENT LINES"].splitlines() if ln.strip()
        ]
        options = parse_options(sections["OPTIONS"])
        correct = sections["CORRECT ANSWER"].strip().lower()
        # Tolerate "b)" or "b." as answer
        if len(correct) > 1:
            correct = correct[0]
        if correct not in {"a", "b", "c", "d"}:
            errors.append({"number": n, "error": f"Invalid correct answer: {sections['CORRECT ANSWER']!r}"})
            correct = ""

        try:
            confidence = int(markers.get("confidence", "0").strip() or 0)
        except ValueError:
            confidence = 0

        try:
            pyq_year_raw = markers.get("pyqyear", "").strip()
            pyq_year = int(pyq_year_raw) if pyq_year_raw else None
        except ValueError:
            pyq_year = None

        q = {
            "number": n,
            "subject": markers.get("subject", "").strip(),
            "section_group": markers.get("sectiongroup", "").strip(),
            "microtopic": markers.get("microtopic", "").strip(),
            "pyq_source": markers.get("pyqsource", "").strip() or None,
            "pyq_year": pyq_year,
            "confidence": confidence,
            "inconsistency_flag": markers.get("inconsistencyflag", "none").strip() or "none",
            "inconsistency_reason": markers.get("inconsistencyreason", "").strip(),
            "statement_lines": statement_lines,
            "question_text": " ".join(statement_lines),
            "options": options,
            "correct_answer": correct,
            "explanation_markdown": sections["EXPLANATION"].strip(),
        }
        # Validate options completeness
        if set(options.keys()) != {"a", "b", "c", "d"}:
            errors.append({"number": n, "error": f"Options incomplete: got {sorted(options.keys())}"})
        questions.append(q)
    return {"questions": questions, "errors": errors, "skipped": skipped}


def validate_against_taxonomy(questions: List[Dict], taxonomy: List[Dict]) -> List[Dict]:
    """Mark each question with `microtopic_valid` boolean."""
    valid_set = {(t["subject"], t["sectionGroup"], t["microTopic"]) for t in taxonomy}
    valid_micros = {t["microTopic"] for t in taxonomy}
    for q in questions:
        triple = (q.get("subject"), q.get("section_group"), q.get("microtopic"))
        q["microtopic_valid"] = triple in valid_set
        q["microtopic_known"] = q.get("microtopic") in valid_micros
    return questions
