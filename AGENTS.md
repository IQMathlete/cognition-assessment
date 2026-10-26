# Internal tools repo — rules for every change

## Structure
- Every tool lives under src/tools/<tool-name>/ and is registered in src/platform/registry.ts with: name, description, owner (a person), roles used, data sensitivity (low/medium/high).
- Never implement auth, permissions, audit, or approvals inside a tool. Use src/platform/{auth,rbac,audit,approvals}.

## Security
- Permission checks happen server-side via requirePermission(). Hiding UI is never the security control.
- Every mutation writes an audit event in the SAME transaction via withAudit(). A mutation without an audit event is a bug.
- Synthetic seed data only. No real names, SSNs, card numbers, or real API keys.

## Definition of done
- Tests prove: (1) unauthorized role rejected server-side, (2) every mutation creates an audit event, (3) approval flows reject self-approval.
- `npm test` and `npm run build` pass before opening a PR.