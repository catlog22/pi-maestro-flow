"""Review-quality scoring rule for the Vision multimodal strategy audit swarm.

Scores an ant artifact by evidence quality and gap-reporting discipline:

  - evidence anchors with file:line  -> strong signal
  - dual-path check (delegation tool vs attached-image auto path) -> architectural rigor
  - known issue linkage              -> relevance to prior findings
  - actionable candidate_solution    -> practical value
  - explicit tri-state + severity    -> disciplined reporting

Returns float in [0.0, 1.0].
"""


def score(ant_artifact: dict) -> float:
    evidence = ant_artifact.get("evidence") or []
    decisions = ant_artifact.get("path_decisions") or []
    solution = ant_artifact.get("candidate_solution") or {}

    anchors = 0
    fileline = 0
    for e in evidence:
        if not isinstance(e, str):
            continue
        anchors += 1
        # heuristic: "path/file.ts:123" or "file.ts:12" shape
        if ":" in e and (".ts" in e or ".js" in e or ".py" in e or ".md" in e):
            fileline += 1

    text = " ".join(
        [str(e) for e in evidence]
        + [str(d) for d in decisions]
        + [str(solution.get("summary", "")), str(solution.get("content", ""))[:500]]
    )
    has_dual = any(k in text for k in ("describe_image", "delegateImage", "attached", "vision")) and any(
        k in text for k in ("对拍", "dual", "both paths", "两处", "root", "委托", "附加图")
    )
    known_issues = sum(
        k in text for k in ("VISION-", "multimodal", "isMultimodalModel", "model.input", "SSRF", "fallback", "cache")
    )
    has_state = any(k in text for k in ("fixed", "live", "risk", "已修复", "现存", "风险", "缺口"))
    has_severity = any(k in text for k in ("high", "medium", "low", "高", "中", "低", "严重"))
    solution_ok = bool(solution.get("summary")) and bool(solution.get("content"))

    score = 0.0
    score += min(0.30, 0.10 * fileline)              # up to 3 file:line anchors
    score += min(0.10, 0.05 * anchors)               # extra evidence breadth
    score += 0.15 if has_dual else 0.0               # dual-path comparison
    score += min(0.15, 0.05 * known_issues)          # linkage to known issues
    score += 0.10 if has_state and has_severity else 0.0
    score += 0.10 if solution_ok else 0.0            # actionable fix direction
    score += 0.10 if len(decisions) >= 1 else 0.0    # path discipline

    return max(0.0, min(1.0, score))
