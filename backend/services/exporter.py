"""Export job → final JSON in schema 2.0 (matches sample schema)."""
from __future__ import annotations
from typing import Dict, List, Any


def _compute_pyq_flags(group: str) -> Dict[str, bool]:
    g = (group or "").strip().upper()
    return {
        "is_upsc_cse": g == "UPSC CSE",
        "is_allied": g.startswith("UPSC") and g != "UPSC CSE",
        "is_others": bool(g) and not g.startswith("UPSC"),
    }


def build_schema2_json(job: Dict, questions: List[Dict]) -> Dict[str, Any]:
    """Build the schema 2.0 JSON given a job document and its questions."""
    md = job.get("metadata") or {}
    test_id = md.get("id") or job.get("id") or "untitled"
    exam_frame = md.get("exam_frame") or {
        "exam_category": "cse",
        "specific_exam": None,
        "stage": "prelims",
        "paper": "pre_gs1",
    }

    out_questions = []
    for q in sorted(questions, key=lambda x: x.get("question_number", 0)):
        n = q.get("question_number")
        statement_lines = q.get("statement_lines") or []
        if not statement_lines and q.get("question_text"):
            statement_lines = [q["question_text"]]
        question_text = q.get("question_text") or " ".join(statement_lines)
        opts = q.get("options") or {}

        is_pyq = bool(q.get("is_pyq") or q.get("pyq_source"))
        pyq_group = q.get("pyq_group") or ""
        pyq_flags = _compute_pyq_flags(pyq_group)

        # Build source_attribution_label if not set
        sal = q.get("source_attribution_label") or ""
        if not sal and is_pyq and pyq_group and q.get("pyq_year"):
            exam_label = q.get("pyq_exam_label") or "Prelims"
            sal = f"{pyq_group} {exam_label} {q['pyq_year']}"

        exam_info = {
            "isPyq": is_pyq,
            "is_ncert": bool(q.get("is_ncert")),
            "exam": q.get("pyq_exam_label") or (q.get("pyq_source") if is_pyq else None),
            "group": pyq_group or None,
            "year": q.get("pyq_year") or None,
            "is_upsc_cse": pyq_flags["is_upsc_cse"],
            "is_allied": pyq_flags["is_allied"],
            "is_others": pyq_flags["is_others"],
            "exam_category": exam_frame.get("exam_category"),
            "specific_exam": exam_frame.get("specific_exam"),
            "stage": exam_frame.get("stage"),
            "paper": exam_frame.get("paper"),
        }

        q_out: Dict[str, Any] = {
            "id": f"{test_id}-q{n:02d}",
            "questionNumber": n,
            "subject": q.get("subject") or "",
            "sectionGroup": q.get("section_group") or "",
            "microTopic": q.get("microtopic") or "",
            "statementLines": statement_lines,
            "questionText": question_text,
            "options": {
                "a": opts.get("a", ""),
                "b": opts.get("b", ""),
                "c": opts.get("c", ""),
                "d": opts.get("d", ""),
            },
            "correctAnswer": q.get("correct_answer") or "",
            "explanationMarkdown": q.get("explanation_markdown") or "",
            "exam_info": exam_info,
        }
        if sal:
            q_out["source_attribution_label"] = sal
        out_questions.append(q_out)

    final = {
        "id": test_id,
        "title": md.get("title", job.get("title", "")),
        "launch_year": md.get("launch_year"),
        "institute": md.get("institute", ""),
        "program_id": md.get("program_id", ""),
        "program_name": md.get("program_name", ""),
        "series": md.get("series", ""),
        "level": md.get("level", ""),
        "paperType": md.get("paperType", ""),
        "defaultMinutes": md.get("defaultMinutes"),
        "sourceMode": md.get("sourceMode", "docx-inline"),
        "schema_version": md.get("schema_version", "2.0"),
        "institute_id": md.get("institute_id"),
        "institute_name": md.get("institute_name"),
        "exam_frame": exam_frame,
        "questions": out_questions,
    }
    return final


def build_markdown(job: Dict, questions: List[Dict]) -> str:
    md = job.get("metadata") or {}
    out = [f"# {md.get('title') or job.get('title','')}", ""]
    out.append(f"- Institute: {md.get('institute','')}")
    out.append(f"- Program: {md.get('program_name','')}")
    out.append(f"- Total questions: {len(questions)}")
    out.append("")
    for q in sorted(questions, key=lambda x: x.get("question_number", 0)):
        n = q.get("question_number")
        pyq_tag = f" [PYQ: {q.get('source_attribution_label') or q.get('pyq_group','')}]" if q.get("is_pyq") else ""
        out.append(f"## Q{n}. ({q.get('subject','?')} → {q.get('section_group','?')} → {q.get('microtopic','?')}){pyq_tag}")
        for line in q.get("statement_lines") or []:
            out.append(line)
        out.append("")
        opts = q.get("options") or {}
        for k in ("a", "b", "c", "d"):
            out.append(f"- {k}) {opts.get(k,'')}")
        out.append("")
        out.append(f"**Correct:** {q.get('correct_answer','')}    **Confidence:** {q.get('confidence',0)}")
        out.append("")
        out.append("**Explanation:**")
        out.append(q.get("explanation_markdown") or "")
        out.append("")
    return "\n".join(out)
