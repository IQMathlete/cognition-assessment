"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/platform/auth";
import { decideRefund, requestRefund } from "./index";

export interface FormState {
  error?: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export async function requestRefundAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const transactionId = String(formData.get("transactionId") ?? "");
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");

  // Strict dollars parse — reject sub-cent precision ("10.005") and anything
  // not a plain decimal rather than silently rounding to a different amount.
  if (!/^\d+(\.\d{1,2})?$/.test(amountRaw)) {
    return { error: "Enter a valid amount (up to 2 decimal places)." };
  }
  const amountCents = Math.round(Number(amountRaw) * 100);

  try {
    await requestRefund(user, { transactionId, amountCents, reason });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  redirect("/tools/refunds/requests");
}

export async function decideRefundAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const approvalRequestId = String(formData.get("approvalRequestId") ?? "");
  const approve = formData.get("decision") === "approve";
  const note = String(formData.get("note") ?? "");

  try {
    await decideRefund(user, { approvalRequestId, approve, note });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/tools/refunds/requests");
  revalidatePath("/tools/refunds");
  return {};
}
