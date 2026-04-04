/** Назва ролі KeyCRM для кур'єрів (як у адмінці CRM). */
export const COURIER_CRM_ROLE_NAME = "Кур'єр";

export function isCourierCrmRole(
  role?: { name?: string } | null,
): boolean {
  const n = role?.name?.trim();
  return n === COURIER_CRM_ROLE_NAME;
}
