// Imported text stays text when the CSV is opened in a spreadsheet.
export const csvCell = (v: unknown) => {
  const text = String(v ?? '');
  return `"${(/^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
};
