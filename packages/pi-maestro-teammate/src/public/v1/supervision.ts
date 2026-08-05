/** Version 1 public supervision contract — unified evaluator, delivery gate, telemetry. */
export { runSupervisedEvaluation, describeSupervisionError } from "../../supervision/evaluator.ts";
export type {
  SupervisedEvaluationContext,
  SupervisedEvaluationParams,
  SupervisedEvaluationResult,
  SupervisionDispatch,
} from "../../supervision/evaluator.ts";
export { DeliveryGate, normalizeDeliveryMessage } from "../../supervision/delivery.ts";
export type {
  DeliveryDedupOptions,
  DeliveryMode,
  DeliveryOptions,
} from "../../supervision/delivery.ts";
export { SUPERVISION_EVENT, createSupervisionEvent } from "../../supervision/types.ts";
export type {
  SupervisionEvent,
  SupervisionKind,
  SupervisionSeverity,
  SupervisionSource,
} from "../../supervision/types.ts";
