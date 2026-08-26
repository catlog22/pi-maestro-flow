import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UserAttentionKind = "plan-confirm" | "plan-review" | "question" | "permission";
export type UserAttentionContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

export interface UserAttentionRequest {
  id: string;
  kind: UserAttentionKind;
  /** Safe display label only. Raw tool input must never enter notifications. */
  subject?: string;
}

export type UserAttentionHandler = (
  request: UserAttentionRequest,
  ctx: UserAttentionContext,
) => void;
