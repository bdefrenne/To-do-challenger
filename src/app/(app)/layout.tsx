/*
  Guarded layout for the whole app. Runs on the server: if there's no
  valid session it bounces to /login before any task data is fetched.
  The resolved user is handed to AppShell (for the sidebar identity +
  logout).
*/

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { AppShell } from "@/components/AppShell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <AppShell user={user}>{children}</AppShell>;
}
