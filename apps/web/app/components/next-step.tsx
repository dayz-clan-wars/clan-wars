import type { NextStep } from "@/lib/next-step";
import { guideLinkFor } from "@/lib/guide-links";
import { GuideLine, btnPrimary, btnSecondary } from "./ui";

/**
 * The gold strip under a page head that says what to do next (App Review
 * §01). Gold is the page's one loud device, so a page showing this shows
 * no other gold panel.
 */
export function NextStepStrip({ step }: { step: NextStep }) {
  const guide = step.guide ? guideLinkFor(step.guide) : undefined;
  return (
    <section aria-label="Next step" className="grid gap-4 border-2 border-gold bg-frame p-4 lg:grid-cols-[auto_1fr_auto] lg:items-center lg:gap-6 lg:px-5">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">{step.kicker}</span>
        <h2 className="m-0 font-display text-xl uppercase leading-none text-ink">{step.title}</h2>
      </div>
      <p className="m-0 text-sm leading-relaxed text-ink-2 [text-wrap:pretty]">{step.body}</p>
      <div className="flex flex-col gap-2 sm:flex-row lg:flex-none">
        <a className={`${btnPrimary} justify-between sm:justify-center`} href={step.primary.href}>{step.primary.label} <span className="font-mono normal-case">→</span></a>
        {step.secondary && <a className={btnSecondary} href={step.secondary.href}>{step.secondary.label}</a>}
      </div>
      {guide && <GuideLine guide={guide} className="lg:col-span-3" />}
    </section>
  );
}
