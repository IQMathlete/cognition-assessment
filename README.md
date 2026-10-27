# Internal Tools Platform

A Power Apps–style internal tools platform for a fintech: one login, role-based
access, audit logging, approval workflows, and an inventory of internal apps.
Next.js (App Router) + TypeScript + Prisma + SQLite.

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

## Seeded users

| username | role |
| --- | --- |
| alice | support_agent |
| bob | support_lead |
| fiona | finance_approver |
| erin | engineer |
| eli | engineer |
| kai | kyc_reviewer |
| sam | kyc_senior |
| adam | platform_admin |

## Architecture

```
src/platform/          Shared platform — tools never talk to the DB without it
  auth/                AuthProvider interface + DevAuthProvider
  rbac.ts              Roles/permissions in code; requirePermission() gate
  audit.ts             withAudit() — writes AuditEvent in the same transaction
  approvals.ts         ApprovalRequest primitive + per-tool decision hooks
  registry.ts          Tool inventory (owner, sensitivity, required permission)
src/tools/refunds/     Reference tool: search transactions, request refunds
src/tools/kyc/         KYC review queue (second governed tool)
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
