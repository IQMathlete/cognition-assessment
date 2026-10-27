# Internal Tools Platform

An internal-tools platform for a fintech — the core of what Microsoft Power
Apps provides, rebuilt as one app: a single login, role-based access control,
audit logging, approval workflows, and an inventory of internal applications.
Next.js (App Router) + TypeScript + Prisma + SQLite.

Every tool on the platform shares the same governance core: permission checks
are server-side, every mutation writes an audit event in the same transaction,
and anything needing sign-off goes through the shared approvals primitive.
The platform ships two governed tools: **Refunds** (payment-refund requests
with amount-threshold approval routing) and **KYC Review** (assigned-case
dispositions with a senior queue and PII masking).

## Getting started

```bash
npm install        # also runs `prisma generate`
npm run seed       # creates prisma/dev.db and loads users + synthetic data
# If the schema changed since your dev.db was created, reset it first:
# npx prisma db push --force-reset && npm run seed
npm run dev        # http://localhost:3000
npm test           # vitest
npm run build      # production build
```

Sign in at `/login` by picking a user — no passwords (see "Not
production-ready").

## Seeded users

| username | role | can do |
| --- | --- | --- |
| alice | support_agent | Search transactions, request refunds (reason required) |
| bob | support_lead | Alice's powers + approve refunds ≤ $250 |
| fiona | finance_approver | Approve refunds > $250 |
| erin, eli | engineer | Read-only access to the refunds tool |
| kai | kyc_reviewer | See his assigned KYC cases; approve / reject / escalate with a reason |
| sam | kyc_senior | See all KYC cases, decide the senior queue (escalations, ≥80-risk second reviews), reveal PII (reason required, audited) |
| adam | platform_admin | `/admin` — tool inventory, searchable audit log, access-review table |

## Demo script

A five-step tour of the governance core:

1. **Request + approve (standard flow).** Sign in as **alice** → Refunds →
   pick a settled transaction ≤ $250 → request a refund with a reason. Sign
   in as **bob** → Refunds → approval queue → approve it. The refund
   executes via the mock payments client; the transaction list shows it
   `executed`.
2. **Threshold routing.** As **alice**, request a refund > $250 → it lands
   in **fiona**'s queue (`finance_approver`), not bob's — bob's queue stays
   empty.
3. **Self-approval blocked.** Have **bob** request a refund on a ≤ $250
   transaction (support_lead can request too) → his own approval queue
   shows the request but the decision buttons are replaced with
   "You cannot decide your own request"; submitting anyway fails
   server-side.
4. **PII masking + reveal.** Sign in as **kai** → KYC Review → SSN shows
   `***-**-1234` and DOB a year only. Kai has no Reveal button. Sign in as
   **sam** → Reveal PII with a reason → the row shows raw values and a
   `kyc_case.pii_revealed` event is written to the audit log.
5. **Audit log.** Sign in as **adam** → `/admin` → Audit log → search
   `kyc_case` or `refund` and expand **before → after** — every mutation
   from steps 1–4 is there, in order, append-only.

## Architecture

```
src/platform/          Shared platform — tools never talk to the DB without it
  auth/                AuthProvider interface + DevAuthProvider (login picker)
  actor.ts             resolveActor() — caller identity resolved from the DB,
                       not from the caller's claims
  rbac.ts              Roles/permissions in code; requirePermission() gate
  audit.ts             withAudit()/recordAudit() — AuditEvent in the same tx;
                       SQLite triggers make audit rows physically append-only
  approvals.ts         ApprovalRequest primitive + per-tool decision hooks;
                       decideApproval() enforces pending-status, required role,
                       no self-approval, and a mandatory ≥10-char justification
  registry.ts          Tool inventory (owner, sensitivity, required permission)
  db.ts                Prisma singleton + audit-guard trigger installation
src/tools/refunds/     Reference governed tool
src/tools/kyc/         KYC review queue
src/app/               App Router pages (login, /, /admin, /tools/*)
```

How a tool plugs in: its service functions start with `resolveActor` +
`requirePermission`; a request creates its entity + `ApprovalRequest` in one
`withAudit` transaction; `registerApprovalHooks(entityType, …)` wires
`requiredPermission`, `validateEntity` (runs inside the decision transaction,
proves the entity is decidable and the request is the entity's own linked
request), and `onApproved`/`onRejected` callbacks that apply the outcome.

- **Auth**: `DevAuthProvider` stores the picked user in an httpOnly cookie.
  **OIDC plug-in point:** replace the provider in `src/platform/auth/` with an
  OIDC implementation (Okta / Microsoft Entra authorization-code flow; map the
  `sub`/`preferred_username` claim to a `User` row). Everything downstream is
  unchanged.
- **Approvals**: decisions carry `decidedBy`, `decisionNote` (the mandatory
  justification), and are audited `approval.approved/rejected`; failed
  attempts audit `approval.decide_failed`. A hook refusing a decision
  (`HookRefusalError`) rolls the decision back.
- **Admin**: `/admin` (platform_admin only) — tool inventory from
  `registry.ts`, a searchable audit log with before → after snapshots, and an
  access-review table (every user × which tools they can open).

### Refunds tool

- `support_agent` searches ~30 seeded transactions and requests a refund
  (reason required); `support_lead` can also request.
- Refund ≤ $250 → `support_lead`; > $250 → `finance_approver`. Routing is
  cumulative-aware: amounts already reserved on a transaction push later
  refunds to finance.
- On approval a `MockPaymentsClient` executes the refund; statuses flow
  `requested → approved/rejected → executed/failed`. Transactions ending in
  `FAIL` exercise the failed path. Refunds that would exceed the transaction's
  remaining refundable amount fail at execution.

### KYC Review tool

- `kyc_reviewer` sees only cases assigned to them; `kyc_senior` sees all 40.
- Dispositions (approve / reject / escalate) each require a reason. Approving
  a case with risk score ≥ 80 — or escalating any case — routes it to the
  senior queue; low-risk approvals verify immediately.
- SSN/DOB are masked server-side in every read (`***-**-1234`, year only) and
  in audit snapshots; `revealPii` requires a reason and audits the reveal.
- Statuses: `pending → verified/rejected` directly, or
  `pending → escalated/pending_second_review → verified/rejected`.

## Not production-ready

This is a working model of the governance core, not a deployable system:

- **Dev auth only** — identity is a user picked from a list in an unsigned
  cookie; anyone can impersonate anyone. Real auth needs the OIDC provider
  plugged in at `src/platform/auth/`.
- **SQLite** — single-file database, no concurrency guarantees beyond what a
  local file gives you; schema is managed with `db push`, no migrations.
- **Mock payments** — `MockPaymentsClient`/`ScreeningClient`-style seams fake
  downstream systems; nothing real executes.
- **No deployment** — runs as a dev server; no infra, no env management.
- **No rate limiting or abuse controls** — request/decision endpoints are
  unthrottled.
- **Not security-reviewed** — the adversarial test suites cover the
  governance-core attack surface we designed for (role spoofing, crafted
  approvals, replay, over-refund, PII exposure), but nothing has been
  pen-tested or audited by a third party.
