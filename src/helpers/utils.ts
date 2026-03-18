export function normalizePhone(phone: string): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "").replace(/^38/, "").trim();
}
