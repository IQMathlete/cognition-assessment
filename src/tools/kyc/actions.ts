"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/platform/auth";
import { decideCase, dispositionCase, revealPii } from "./index";

export interface FormState {
  error?: string;
  revealed?: { ssn: string; dob: string };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export async function dispositionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const caseId = String(formData.get("caseId") ?? "");
  const action = String(formData.get("action") ?? "");
  const reason = String(formData.get("reason") ?? "");

  try {
    await dispositionCase(user, { caseId, action, reason });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/tools/kyc");
  revalidatePath("/tools/kyc/requests");
  return {};
}

export async function decideCaseAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const approvalRequestId = String(formData.get("approvalRequestId") ?? "");
  const approve = formData.get("decision") === "approve";
  const note = String(formData.get("note") ?? "");

  try {
    await decideCase(user, { approvalRequestId, approve, note });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/tools/kyc/requests");
  revalidatePath("/tools/kyc");
  return {};
}

export async function revealPiiAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const caseId = String(formData.get("caseId") ?? "");
  const reason = String(formData.get("reason") ?? "");

  try {
    const revealed = await revealPii(user, { caseId, reason });
    revalidatePath("/tools/kyc");
    return { revealed };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}
