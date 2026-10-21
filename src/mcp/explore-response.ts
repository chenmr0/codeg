/** Bound the complete response, including its omission notice, without claiming file completeness. */
export function capExploreResponse(output: string, hardCeiling: number): string {
  if (output.length <= hardCeiling) return output;
  const notice = '\n\n> Output truncated to budget. Only the shown source ranges are covered; omitted bodies and file regions may require a targeted query or Read.';
  // Reserve a closing fence for the single-section fallback as well as the notice.
  const cut = output.slice(0, Math.max(0, hardCeiling - notice.length - 4));
  const lastSection = cut.lastIndexOf('\n#### ');
  const boundary = lastSection > hardCeiling * 0.5 ? lastSection : cut.lastIndexOf('\n');
  let safe = boundary > 0 ? cut.slice(0, boundary) : cut;
  if ((safe.match(/^```/gm)?.length ?? 0) % 2 !== 0) safe += '\n```';
  return (safe + notice).slice(0, hardCeiling);
}
