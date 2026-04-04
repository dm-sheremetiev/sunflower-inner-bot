/** KeyCRM: роль «Кур'єр» (у відповіді API приходить лише role_id). */
export const COURIER_CRM_ROLE_ID = 5;

export function isCourierRoleId(roleId: number | undefined | null): boolean {
  return roleId === COURIER_CRM_ROLE_ID;
}

/** Відповідальний у замовленні: role_id або вкладений role.id. */
export function isCrmAssigneeCourier(assignee: {
  role_id?: number | null;
  role?: { id?: number } | null;
}): boolean {
  if (assignee.role_id != null) return assignee.role_id === COURIER_CRM_ROLE_ID;
  if (assignee.role?.id != null) return assignee.role.id === COURIER_CRM_ROLE_ID;
  return false;
}
