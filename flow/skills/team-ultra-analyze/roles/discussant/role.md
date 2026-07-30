---
role: discussant
prefix: DISCUSS
inner_loop: false
message_types:
  success: discussion_processed
  error: error
---

# Discussant

## Phase 2: Context Loading

| Input | Source | Required |
|-------|--------|----------|
| Task description | From task subject/description | Yes |
| Session path | Extracted from task description | Yes |
| Analysis results | `{run_dir}/outputs/analyses/*.json` | Yes |
| Exploration results | `{run_dir}/work/team/explorations/*.json` | No |

1. Extract session path, topic, round, discussion type, user feedback:

| Field | Pattern | Default |
|-------|---------|---------|
| sessionFolder | `session:\s*(.+)` | required |
| topic | `topic:\s*(.+)` | required |
| round | `round:\s*(\d+)` | 1 |
| discussType | `type:\s*(.+)` | "initial" |
| userFeedback | `user_feedback:\s*(.+)` | empty |

2. Read all analysis and exploration results
3. Aggregate current findings, insights, open questions

## Phase 3: Discussion Processing

Select strategy by discussion type:

| Type | Mode | Description |
|------|------|-------------|
| initial | inline | Aggregate all analyses: convergent themes, conflicts, top discussion points |
| deepen | cli | Use CLI tool to investigate open questions deeper |
| direction-adjusted | cli | Re-analyze via `teammate` from adjusted perspective |
| specific-questions | cli | Targeted exploration answering user questions |

**initial**: Cross-perspective summary -- identify convergent themes, conflicting views, top 5 discussion points and open questions from all analyses.

**deepen**: Use CLI tool for deep investigation:
```javascript
Bash({
  command: `teammate({ agent: "delegate", taskType: "analysis", task: "PURPOSE: Investigate open questions and uncertain insights; success = evidence-based findings\nTASK: • Focus on open que…", prompt: "analysis-trace-code-execution" })
  background: false
})
```

**direction-adjusted**: CLI re-analysis from adjusted focus:
```javascript
Bash({
  command: `teammate({ agent: "delegate", taskType: "analysis", task: "Re-analyze '<topic>' with adjusted focus on '<userFeedback>'", /* --to agy: set model via model-availability */ })
  background: false
})
```

**specific-questions**: Use CLI tool for targeted Q&A:
```javascript
Bash({
  command: `teammate({ agent: "delegate", taskType: "analysis", task: "PURPOSE: Answer specific user questions about <topic>; success = clear, evidence-based answers\nTASK: • Answer: <userFee…" })
  background: false
})
```

## Phase 4: Update Discussion Timeline

1. Write round content to `{run_dir}/evidence/discussions/discussion-round-<num>.json`:
```json
{
  "round": 1, "type": "initial", "user_feedback": "...",
  "updated_understanding": { "confirmed": [], "corrected": [], "new_insights": [] },
  "new_findings": [], "new_questions": [], "timestamp": "..."
}
```

2. Append round section to `{run_dir}/evidence/discussion.md`:
```markdown
### Round <N> - Discussion (<timestamp>)
#### Type: <discussType>
#### User Input: <userFeedback or "(Initial discussion round)">
#### Updated Understanding
**Confirmed**: <list> | **Corrected**: <list> | **New Insights**: <list>
#### New Findings / Open Questions
```

Update `{run_dir}/work/team/wisdom/.msg/meta.json` under `discussant` namespace:
- Read existing -> merge `{ "discussant": { round, type, new_insight_count, corrected_count } }` -> write back
