// Check output and traces must never show a check secret: replace each one,
// and the encodings it most often leaks in, with its name.

export function maskSecrets(output: string, secrets: Record<string, string>): string {
  const forms: [string, string][] = [];
  for (const [name, v] of Object.entries(secrets)) {
    if (v.length < 4) continue;
    forms.push([v, name]);
    try { forms.push([btoa(v), name]); } catch { /* not latin-1 */ }
    if (encodeURIComponent(v) !== v) forms.push([encodeURIComponent(v), name]);
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  for (const [v, name] of forms) output = output.split(v).join(`[secret ${name}]`);
  return output;
}
