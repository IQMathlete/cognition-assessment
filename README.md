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
npm run seed       # creates prisma/dev.db and loads users + transactions
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

- **Auth**: `AuthProvider` in `src/platform/auth/provider.ts`. `DevAuthProvider`
  lists seeded users on `/login` and stores the choice in an httpOnly cookie —
  no passwords. **OIDC plug-in point:** replace the provider in
  `src/platform/auth/index.ts` with an OIDC implementation (Okta / Microsoft
  Entra authorization-code flow; map the `sub`/`preferred_username` claim to a
  `User` row). Everything downstream uses `getCurrentUser()` and is unchanged.
- **RBAC**: roles and permissions live in `src/platform/rbac.ts`.
  `requirePermission(user, permission)` is the single server-side gate.
- **Audit**: `withAudit(actorId, work)` runs a mutation and writes its
  `AuditEvent` rows (actor, action, entity type/id, before/after JSON) in the
  same transaction. `AuditEvent` is append-only — no update/delete paths exist.
- **Approvals**: tools create an `ApprovalRequest` (requester, required
  approver role, status, decided_by, reason) in the same transaction as the
  entity needing approval. `decideApproval()` enforces pending-status, the
  required role, and rejects self-approval; decisions are audited. Tools
  register `onApproved`/`onRejected` hooks via `registerApprovalHooks`.
- **Admin**: `/admin` (platform_admin only) shows the tool inventory, a
  searchable audit log, and an access-review table (user × tool).

## Refunds tool

- `support_agent` searches transactions and requests a refund (reason required).
- Refund ≤ $250 → `support_lead` approves; > $250 → `finance_approver`.
- On approval a `PaymentsClient` (`src/tools/refunds/payments.ts`,
  `MockPaymentsClient` by default) executes the refund; statuses flow
  `requested → approved/rejected → executed/failed`. Every transition is
  audited. Transactions whose `externalId` ends in `FAIL` are declined by the
  mock issuer to exercise the failed path.

## KYC Review tool

- `kyc_reviewer` sees only the cases assigned to them (`assigneeId`); a
  `kyc_senior` sees the whole queue.
- On a pending case the reviewer dispositions it — **approve**, **reject**,
  or **escalate** — with a required reason. Approving a case with risk score
  ≥ 80, or escalating any case, routes it to the senior queue via the shared
  approvals primitive (`kyc_senior` decides); low-risk approvals verify
  immediately.
- PII (`ssn`, `dob`) is masked server-side in every read (`***-**-1234`,
  birth year only). `kyc_senior` can reveal the values via `revealPii`,
  which requires a reason and writes a `kyc_case.pii_revealed` audit event
  recording the reason and the fields revealed — never the values.
- Statuses flow `pending → verified/rejected` directly, or
  `pending → escalated/pending_second_review → verified/rejected` through
  the senior queue. Every transition is audited.

## Building a new internal tool

A new tool is a recipe, not a redesign — the platform supplies auth, RBAC,
audit, and approvals; the tool supplies a data model, a permission set, a
status machine, and a queue. The build-internal-tool skill codifies this
scaffold:

1. **Model** — add the entity to `prisma/schema.prisma` (requester,
   assignee, status, whatever the tool decides), `npx prisma db push`,
   extend `npm run seed` with synthetic rows and users.
2. **Permissions** — add `<tool>:read` / `:create` / `:approve` to
   `Permission` in `src/platform/rbac.ts` and grant them to roles (existing
   or new).
3. **Service** — `src/tools/<tool>/service.ts`: a status-transition table,
   `requirePermission()` on every entry point, `resolveActor()` for the
   caller, `withAudit()` around every mutation, and
   `createApprovalRequest()` + `registerApprovalHooks()` wherever work
   needs sign-off.
4. **Actions + pages** — thin server actions in
   `src/tools/<tool>/actions.ts`; pages under `src/app/tools/<tool>/`. The
   requester's queue filters by assignee/requester; the approver's queue
   reads `listPendingApprovalsFor`.
5. **Register** — one `toolRegistry` entry (slug, name, owner, sensitivity,
   requiredPermission) puts it in the sidebar and the `/admin` inventory.
6. **Tests** — the AGENTS.md definition of done: unauthorized role rejected
   server-side, every mutation audited, no self-approval.

### Example: a ticketing system

The same skeleton is a ticket queue with sign-off built in:

- `Ticket` model: title, body, `requesterId`, `assigneeId`, priority,
  status (`open → triaged → in_progress → resolved/closed`).
- Roles: reuse `support_agent` (files tickets) and `support_lead` (triages,
  assigns, approves closures), or add dedicated `ticket_agent`/`ticket_lead`.
- Queue: an agent sees only tickets where `assigneeId` is them; a lead sees
  all — the same scoping the KYC tool uses.
- Approvals: high-priority tickets route to the lead's approval queue
  before work starts, or resolving requires lead sign-off — the same
  `ApprovalRequest` primitive, justification requirement, and
  self-approval guard.
- Audit: every assignment, status change, and decision lands in the audit
  log; `/admin` is the searchable ticket history for free.
