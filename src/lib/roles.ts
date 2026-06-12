import { Role } from "@prisma/client";

export type AppRole = "waiter" | "manager" | "cook" | "architect" | "hybrid";

export const staffServiceRoles: Role[] = [Role.WAITER, Role.HYBRID];
export const kitchenServiceRoles: Role[] = [Role.COOK, Role.HYBRID];

export function serializeRole(role: Role): AppRole {
  if (role === Role.MANAGER) return "manager";
  if (role === Role.COOK) return "cook";
  if (role === Role.ARCHITECT) return "architect";
  if (role === Role.HYBRID) return "hybrid";
  return "waiter";
}

export function roleMatches(actualRole: string | undefined, allowedRoles: string[]) {
  if (!actualRole) return false;
  if (allowedRoles.includes(actualRole)) return true;
  if (actualRole !== "hybrid") return false;
  return allowedRoles.includes("waiter") || allowedRoles.includes("cook");
}
