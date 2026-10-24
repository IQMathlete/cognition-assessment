"use server";

import { authProvider } from "@/platform/auth";
import { redirect } from "next/navigation";

export async function signOutAction() {
  await authProvider.signOut();
  redirect("/login");
}
