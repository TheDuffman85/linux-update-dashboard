export function filterBySearch<T>(
  items: T[],
  search: string,
  getFields: (item: T) => (string | null | undefined)[],
): T[] {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const query = normalize(search);
  if (!query) return items;
  return items.filter((item) =>
    getFields(item).some((field) => field != null && normalize(field).includes(query)),
  );
}
