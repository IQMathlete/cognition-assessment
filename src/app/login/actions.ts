"use server";

import { authProvider } from "@/platform/auth";
import { redirect } from "next/navigation";

export async function signInAction(formData: FormData) {
  const username = String(formData.get("username") ?? "");
  await authProvider.signIn(username);
  redirect("/");
}
