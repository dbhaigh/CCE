import React, { useState } from "react";

const steps = [
  { tab: "overview", title: "Your empire at a glance",
    text: "Follow actual balances and the production links on Resource overview. Start here whenever a bottleneck appears." },
  { tab: "agents", title: "1 · Source generation",
    text: "Hire engineers and recruit agents to generate Source. Funded teams and swarms produce the work your build pipeline needs." },
  { tab: "build", title: "2 · Build and compilation",
    text: "Queue Source for compilation and watch compute, Binaries, and pipeline bottlenecks." },
  { tab: "runtime", title: "3 · Testing and deployment",
    text: "Tests turn Binaries into reliable Releases. Choose a deployment strategy and watch incidents in the runtime log." },
  { tab: "debt", title: "4 · Debt, policy and research",
    text: "Pay down technical debt, tune governance under Policy, and invest Insight under Research / insight for lasting improvements." },
] as const;

export function FirstRunIntro({ onNavigate, onFinish }: {
  onNavigate: (tab: string) => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState(0);
  const current = steps[step]!;
  const go = (next: number) => {
    setStep(next);
    onNavigate(steps[next]!.tab);
  };
  return <section aria-label="First-run guided introduction" className="panel mb-5 border-cyan-700/70">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-mono text-xs uppercase tracking-wide text-cyan-300">Quick tour · {step + 1} / {steps.length}</p>
        <h2 className="mt-1 font-semibold text-cyan-100">{current.title}</h2>
      </div>
      <button type="button" className="button" onClick={onFinish} aria-label="Dismiss introduction">Skip tour</button>
    </div>
    <p className="mt-2 text-sm text-slate-300">{current.text}</p>
    <p className="mt-1 text-xs text-slate-400">Each step opens a section; the seven game sections remain available in the navigation.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="button" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
      {step === steps.length - 1 && <>
        <button type="button" className="button" onClick={() => onNavigate("policy")}>Explore Policy</button>
        <button type="button" className="button" onClick={() => onNavigate("research")}>Explore Research</button>
      </>}
      {step < steps.length - 1
        ? <button type="button" className="button selected" onClick={() => go(step + 1)}>Next section</button>
        : <button type="button" className="button selected" onClick={onFinish}>Finish tour</button>}
    </div>
  </section>;
}
