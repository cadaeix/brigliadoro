import type { ResourceState, ResourceOpResult } from "../types/index.js";

function clamp(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;
  return result;
}

/**
 * Set a resource to an absolute value, optionally establishing min/max bounds.
 *
 * @param entity - Entity name (e.g. "Valeria", "Party")
 * @param resource - Resource name (e.g. "HP", "gold")
 * @param value - New value
 * @param current - Current state, or undefined if creating a new resource
 * @param bounds - Optional min/max bounds (overrides existing bounds if provided)
 */
export function setResource(
  entity: string,
  resource: string,
  value: number,
  current?: ResourceState,
  bounds?: { min?: number; max?: number }
): ResourceOpResult {
  const previousValue = current?.value ?? 0;
  const min = bounds?.min ?? current?.min;
  const max = bounds?.max ?? current?.max;
  const newValue = clamp(value, min, max);

  return {
    entity,
    resource,
    previousValue,
    newValue,
    clampedAtMin: min !== undefined && newValue === min && value < min,
    clampedAtMax: max !== undefined && newValue === max && value > max,
  };
}

/**
 * Modify a resource by a delta (positive to add, negative to subtract).
 * Clamps to the resource's min/max bounds.
 */
export function modifyResource(
  entity: string,
  resource: string,
  delta: number,
  current: ResourceState
): ResourceOpResult {
  const previousValue = current.value;
  const raw = current.value + delta;
  const newValue = clamp(raw, current.min, current.max);

  return {
    entity,
    resource,
    previousValue,
    newValue,
    clampedAtMin: current.min !== undefined && newValue === current.min && raw < current.min,
    clampedAtMax: current.max !== undefined && newValue === current.max && raw > current.max,
  };
}
