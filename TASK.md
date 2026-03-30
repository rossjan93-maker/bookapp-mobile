# Objective
Fix the in-app walkthrough so it teaches the app through real UI components instead of random highlighted regions.

# Product intent
A new user should feel like the app is guiding them through the real product itself. Every walkthrough step should point to a specific real thing on screen, and the copy should match exactly what is visible.

# Scope
Files/surfaces allowed to change:
- walkthrough engine
- walkthrough overlay
- tab walkthrough sequencing
- Recommendations walkthrough gating
- first-run walkthrough copy
- intro/welcome handoff only if needed for walkthrough correctness

Files/surfaces frozen unless absolutely necessary:
- core recommendation scoring
- unrelated theme tokens
- unrelated product flows

# Required behavior
- every walkthrough step must target a specific real measured UI component
- no walkthrough step may fire until the thing being discussed exists, is visible, and is measured
- no generic rectangular “area” highlighting
- Home, Recommendations, Library, Inbox, and Profile must all be intentionally handled
- Recommendations step must highlight either:
  - a real recommendation card, or
  - the real setup/import prompt
- if neither exists yet, the Recommendations walkthrough step must wait
- walkthrough visuals must stay on-brand with the app’s existing theme

# UX acceptance criteria
- the user’s eye is drawn to a real component, not a vague lit region
- copy and highlighted target always match
- no “Your picks” copy over skeletons/placeholders
- walkthrough order feels coherent and product-led
- Inbox/Profile are either explicitly included or intentionally excluded with rationale
- overlay styling feels native to the app

# Technical gates
- project builds successfully
- no runtime errors on walkthrough flow
- no dead-end onboarding/walkthrough states
- Continue / Skip / walkthrough progression all work

# Runtime evidence required
- changed files summary
- build output
- screenshot/video notes for each walkthrough step
- explanation of which exact component is highlighted for each step
- explanation of readiness gating for each step

# Forbidden shortcuts
- do not use approximate region masks when a real component can be targeted
- do not explain skeleton/placeholder content as if it were real
- do not introduce off-brand accent colors
- do not declare success based only on compilation

# Escalate instead of auto-accept if
- walkthrough is technically working but still visually clunky
- target alignment still feels subjective
- there is a design tradeoff that needs human judgment