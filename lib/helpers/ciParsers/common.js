/**
 * Ensure all step objects in the array are unique (CycloneDX `uniqueItems: true`).
 *
 * Identical steps are disambiguated by appending a ` (N)` counter to the step name.
 * The first occurrence is always left unchanged.
 *
 * @param {Object[]} steps
 * @returns {Object[]|undefined}
 */
export function disambiguateSteps(steps) {
  if (!steps?.length) {
    return undefined;
  }
  const seenKeys = new Map();
  return steps.map((step) => {
    const key = JSON.stringify(step);
    const count = seenKeys.get(key) ?? 0;
    seenKeys.set(key, count + 1);
    if (count === 0) {
      return step;
    }
    return { ...step, name: `${step.name} (${count + 1})` };
  });
}
