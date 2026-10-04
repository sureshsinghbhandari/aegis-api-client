/** Offer `text` as a file download using a Blob and a temporary <a download> link (no network involved). */
export function downloadText(fileName: string, text: string, mime: string): void {
  const safe = fileName.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'download';
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safe;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
