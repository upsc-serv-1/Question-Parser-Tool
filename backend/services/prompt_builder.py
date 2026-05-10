"""Gemini prompt builder. Outputs prompts that the user pastes into Gemini web."""
from __future__ import annotations
from typing import List, Dict
import json
from pathlib import Path

TAXONOMY_PATH = Path(__file__).parent.parent / "data" / "taxonomy.json"


def load_taxonomy() -> List[Dict]:
    return json.loads(TAXONOMY_PATH.read_text())


def taxonomy_text(tax: List[Dict]) -> str:
    """Render taxonomy as a flat list grouped by subject."""
    grouped: Dict[str, Dict[str, list]] = {}
    for e in tax:
        s = e["subject"]; sg = e["sectionGroup"]; mt = e["microTopic"]
        grouped.setdefault(s, {}).setdefault(sg, []).append(mt)
    lines = []
    for s in sorted(grouped):
        lines.append(f"\n## {s}")
        for sg in sorted(grouped[s]):
            lines.append(f"  - {sg}:")
            for mt in grouped[s][sg]:
                lines.append(f"      • {mt}")
    return "\n".join(lines)


SYSTEM_RULES = """You are a meticulous quiz JSON extractor for UPSC / state-PSC coaching tests.

For EACH question I provide, output a structured block. Be strict with the format — a regex parser depends on it.

RULES:
1. Output exactly ONE block per question, in question-number order.
2. Every block starts with `=== QUESTION N ===` (N = question number, integer).
3. Markers (square-brackets) come first; they are single-line each. Empty value is allowed (e.g., `[PYQYear: ]`).
4. Then four delimiter sections: STATEMENT LINES, OPTIONS, CORRECT ANSWER, EXPLANATION.
5. STATEMENT LINES — one per line; preserve numbering / Roman numerals; the LAST line is normally the actual question (e.g., "How many of the above are correct?"). For simple Qs, just one line is fine.
6. OPTIONS — exactly four lines starting `a) `, `b) `, `c) `, `d) ` (lowercase letter + paren + space).
7. CORRECT ANSWER — single character: `a`, `b`, `c`, or `d`.
8. EXPLANATION — markdown allowed (use **bold**, lists, headings sparingly). Be thorough but do not invent facts.
9. [Microtopic] MUST be exactly one of the entries in the taxonomy below. If unsure, pick the closest and lower [Confidence] accordingly.
10. [InconsistencyFlag] ∈ {none, qp_sol_topic_mismatch, option_not_found_in_qp, q_number_suspected_swap, incomplete_question, incomplete_explanation}
11. [Confidence] ∈ 0–100 integer. Lower if any flag set, OCR garble visible, or you had to guess heavily.
12. [PYQSource] / [PYQYear] empty if not detected. Sources e.g., UPSC, BPSC, UPPCS.

Do NOT add any commentary outside the blocks. Do NOT use code-fences. Do NOT translate.
"""

FORMAT_EXAMPLE = """=== QUESTION 1 ===
[Subject: Polity]
[SectionGroup: Institutions & Governance]
[Microtopic: Governance and Policies]
[PYQSource: ]
[PYQYear: ]
[Confidence: 95]
[InconsistencyFlag: none]
[InconsistencyReason: ]

--- STATEMENT LINES ---
With reference to Indian polity, which of the following statements is not correct regarding the whip system in Parliament?

--- OPTIONS ---
a) The office of the Whip is mentioned neither in the Constitution of India nor in the Rules of Procedure...
b) The Minister of Home Affairs serves as the Chief Whip of the ruling party in the Lok Sabha.
c) Violation of a party whip may attract disqualification under the provisions of Tenth Schedule...
d) A political party cannot issue an enforceable whip to its members for voting in the Presidential election.

--- CORRECT ANSWER ---
b

--- EXPLANATION ---
Option b is the correct answer. A **Whip is a formal direction** issued by a political party...
- Statement a is correct: the office is not mentioned in the Constitution.
- Statement b is incorrect: the Minister of Parliamentary Affairs (not Home) serves as Chief Whip.
"""


def build_batch_prompt(
    items: List[Dict],
    *,
    batch_index: int,
    total_batches: int,
    subject_filter: List[str] | None = None,
    extra_instructions: str = "",
) -> str:
    """Build the full prompt for one batch of questions.

    Each item: {"number": int, "qp_text": str, "sol_text": str|None}
    """
    tax = load_taxonomy()
    tax_block = taxonomy_text(tax)
    subj_clause = ""
    if subject_filter:
        subj_clause = (
            f"\nSUBJECT FILTER: Only output questions whose subject is one of: "
            f"{', '.join(subject_filter)}. For others, write `=== QUESTION N === [SKIPPED: out_of_subject_filter]` only.\n"
        )
    # Build the raw question blocks
    q_blocks = []
    for it in items:
        n = it["number"]
        qp = (it.get("qp_text") or "").strip()
        sol = (it.get("sol_text") or "").strip()
        block = f"--- RAW QUESTION {n} (FROM QP) ---\n{qp}"
        if sol:
            block += f"\n\n--- RAW SOLUTION {n} (FROM SOL) ---\n{sol}"
        q_blocks.append(block)
    raw_questions = "\n\n".join(q_blocks)

    parts = [
        SYSTEM_RULES,
        subj_clause,
        f"\nBATCH: {batch_index + 1} of {total_batches}. Question numbers in this batch: "
        + ", ".join(str(it["number"]) for it in items),
        "\n=== TAXONOMY (240 entries — pick microtopic strictly from this list) ===",
        tax_block,
        "\n=== OUTPUT FORMAT EXAMPLE ===",
        FORMAT_EXAMPLE,
    ]
    if extra_instructions.strip():
        parts.append(f"\n=== ADDITIONAL INSTRUCTIONS FROM USER ===\n{extra_instructions.strip()}")
    parts.append("\n=== RAW QUESTIONS TO PROCESS ===")
    parts.append(raw_questions)
    parts.append(
        "\n=== END ===\nNow produce one `=== QUESTION N ===` block per question, in order, following the format strictly."
    )
    return "\n".join(parts)


def build_reverify_prompt(items: List[Dict], previous_microtopics: Dict[int, str] | None = None) -> str:
    """Build a re-verify prompt for a list of low-confidence questions."""
    base = build_batch_prompt(items, batch_index=0, total_batches=1)
    notes = "\n\n=== RE-VERIFY MODE ===\nThese questions had low confidence in the first pass."
    if previous_microtopics:
        notes += " Previous tentative microtopic guesses:\n"
        for n, mt in previous_microtopics.items():
            notes += f"  Q{n}: {mt}\n"
    notes += "\nRe-evaluate carefully. If you reach the same answer with high confidence, repeat it; otherwise correct."
    return base + notes
