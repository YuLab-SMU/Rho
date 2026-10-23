// The deterministic stdio walkthrough shares the executable journey. It makes no
// claim that reading Skill text is a model run; scripts/agent-experiment.mjs is one.
if (process.env.RHO_WALK_EVIDENCE) process.env.RHO_EXECUTION_EVIDENCE = process.env.RHO_WALK_EVIDENCE;
await import('./execution-acceptance.mjs');
