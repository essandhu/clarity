import type { Stage } from "@/shared/schema";
import type { StepView } from "./runState";
import { StepRow } from "./StepRow";

// Live agent-step visualization (§8 showpiece): one StepRow per step.started,
// grouped under stage headers in first-appearance order.

const STAGE_TITLES: Record<Stage, string> = {
  extraction: "Reading the listing",
  enrichment: "Researching the company",
  synthesis: "Writing the briefing",
};

export function AgentStepTimeline({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) return null;

  const stageOrder: Stage[] = [];
  const byStage = new Map<Stage, StepView[]>();
  for (const step of steps) {
    const group = byStage.get(step.stage);
    if (group) group.push(step);
    else {
      byStage.set(step.stage, [step]);
      stageOrder.push(step.stage);
    }
  }

  return (
    <section className="timeline" aria-label="Agent steps">
      {stageOrder.map((stage) => (
        <div key={stage} className={`timeline-stage stage-${stage}`}>
          <h2 className="stage-title">{STAGE_TITLES[stage]}</h2>
          <ol className="step-list">
            {(byStage.get(stage) ?? []).map((step) => (
              <StepRow key={step.stepId} step={step} />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
