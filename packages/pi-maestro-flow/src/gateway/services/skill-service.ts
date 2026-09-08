/** Authenticated Gateway facade for policy-scoped skill discovery and loading. */
import { randomUUID } from "node:crypto";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import type { GatewaySkillRequest } from "../skill-contracts.ts";
import { GatewaySkillPolicy, GatewaySkillPolicyError } from "../skill-policy.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";

const DEFAULT_PAGE_SIZE = 64;

export class GatewaySkillService {
  constructor(readonly skillPolicy: GatewaySkillPolicy) {}

  async handle(principal: GatewayPrincipal, request: GatewaySkillRequest): Promise<GatewayResult<unknown>> {
    const requestId = request.requestId ?? randomUUID();
    const principalId = principalKey(principal);
    try {
      if (request.action === "list") {
        const cursor = request.cursor ?? 0;
        const limit = request.limit ?? DEFAULT_PAGE_SIZE;
        const query = request.query?.trim().toLocaleLowerCase();
        const discovered = await this.skillPolicy.list(principal, request.workspaceId);
        const filtered = query
          ? discovered.filter(({ descriptor }) => `${descriptor.name}\n${descriptor.description ?? ""}`.toLocaleLowerCase().includes(query))
          : discovered;
        const skills = filtered.slice(cursor, cursor + limit).map(({ descriptor }) => descriptor);
        const nextCursor = cursor + skills.length;
        const data = { workspaceId: request.workspaceId, skills, nextCursor, hasMore: nextCursor < filtered.length };
        this.skillPolicy.assertResponse(data);
        return gatewayOk(data, { requestId, principalId });
      }
      if (request.action === "load") {
        const resource = await this.skillPolicy.load(principal, request.workspaceId, request.skillId, request.resourceId);
        return gatewayOk({ workspaceId: request.workspaceId, resource }, { requestId, principalId });
      }
      return gatewayError({ code: "invalid_action", message: "Unsupported skill action" }, { requestId, principalId });
    } catch (error) {
      if (error instanceof GatewaySkillPolicyError) {
        const hidden = error.code === "skill_not_found" || error.code === "skill_resource_not_found";
        return gatewayError({ code: hidden ? "not_found" : error.code, message: hidden ? "Skill resource was not found" : error.message }, { requestId, principalId });
      }
      return gatewayError({ code: "skill_action_failed", message: error instanceof Error ? error.message : String(error) }, { requestId, principalId });
    }
  }
}
