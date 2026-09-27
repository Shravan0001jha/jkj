# Product unit

The Product unit is where a feature enters the Workplace and where a decision leaves it for the owner. It holds two charters: `chief-of-staff` and `product-and-business`. Asha leads it as Chief of Staff and holds both charters until the definition work grows enough to split them.

## What it is for

- Turning a feature the owner states once into a spec with acceptance criteria, decomposed by the ownership map into assignments for the charters it touches, whatever axis they are on.
- Holding the product definition (`~/jkj/docs/product-definition-extract.md`), the 110-feature checklist status and the 96 requirement candidates, so every line of the definition traces to an owning charter, to work and to evidence.
- Routing every decision the definition leaves open (push-to-talk default, quiet by default, the pricing architecture, which phone next, the friend network, the ₹2,000 audit, transcript privacy) to the owner's Inbox with a recommendation, never deciding it silently.
- Proposing org changes (hire, split, merge, reassign) from real signals, as diffs the owner approves, and leading the repo split by ownership.

## How the charters coordinate

- `product-and-business` produces documents and decisions; `chief-of-staff` turns approved decisions into specs and assignments. A feature that waits on an open decision is marked waiting, not started on an assumption.
- Requirement ids come from product-and-business; the map and the lint that says every requirement has exactly one owner come from chief-of-staff.
- Both talk to the owner through the Inbox and Telegram (`~/iris-ops/notify.sh`), in 3–5 lines, at milestones or for a real blocker.

## Shared rules

- Non-code work's evidence is the doc or the owner's Inbox decision. A requirement moves to built or verified only on evidence from the owning charter, confirmed by QA.
- The owner's numbers are hard contracts. The build order for anything new is HLD → LLD → TDD → code.
- An AI manager's approval is not a safety gate: releases, deploys, permanent hires, org changes and spend above the cap are the owner's.
- Foundations before features (A1 mode layer, A2 sensor consent, A3 account data layer, A4 presence, A5 entitlements, A6 portable character, B1 behaviour lock).

## Who leads

Asha (Chief of Staff). Escalation from every other unit ends here before it reaches the owner, and only real decisions go on.
