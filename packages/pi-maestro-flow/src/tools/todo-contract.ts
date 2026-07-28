export const TODO_UPDATE_FIELDS = [
  "subject",
  "description",
  "status",
  "blockedBy",
  "context",
  "skills",
  "summary",
  "assignee",
  "goalId",
] as const;

export type TodoUpdateField = (typeof TODO_UPDATE_FIELDS)[number];
