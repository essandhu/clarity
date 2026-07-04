// Clock is injected (PLAN.md decision 22) so budget-deadline tests jump a
// fake clock instead of sleeping. The domain never reads Date.now() directly.
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
