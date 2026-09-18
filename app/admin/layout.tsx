import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/lib/auth/admin";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/request-user";
import { AUTHENTICATED_IDENTITY_SOURCE_HEADER, isVerifiedIdentitySource } from "@/lib/auth/strip-identity";
import { AdminShell } from "./admin-shell";

export const metadata = { title: "Admin Portal" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const reqHeaders = await headers();
  const email = reqHeaders.get(AUTHENTICATED_EMAIL_HEADER);
  const source = reqHeaders.get(AUTHENTICATED_IDENTITY_SOURCE_HEADER);
  
  if (!isVerifiedIdentitySource(source) || !isAdminEmail(email)) {
    redirect("/console");
  }
  
  return <AdminShell adminEmail={email}>{children}</AdminShell>;
}
