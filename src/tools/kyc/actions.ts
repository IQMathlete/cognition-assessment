"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/platform/auth";
import { decideReview, requestReview } from "./index";

export interface FormState {
  error?: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export async function requestReviewAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const caseId = String(formData.get("caseId") ?? "");
  const recommendation = String(formData.get("recommendation") ?? "");
  const reason = String(formData.get("reason") ?? "");

  try {
    await requestReview(user, { caseId, recommendation, reason });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  redirect("/tools/kyc/requests");
}

export async function decideReviewAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const approvalRequestId = String(formData.get("approvalRequestId") ?? "");
  const approve = formData.get("decision") === "approve";
  const note = String(formData.get("note") ?? "");

  try {
    await decideReview(user, { approvalRequestId, approve, note });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/tools/kyc/requests");
  revalidatePath("/tools/kyc");
  return {};
}
