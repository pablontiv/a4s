/** Replace only known path roots, longest first, without consuming sibling names. */
export function redactRoots(value: string, roots: readonly (readonly [string, string])[]): string {
  let text = value;
  for (const [root, placeholder] of [...roots].sort((a, b) => b[0].length - a[0].length)) {
    if (!root) continue;
    const source = text;
    text = source.replaceAll(root, (_match, offset: number) => {
      const next = source[offset + root.length];
      return next === undefined || /[\/\\\s"'`<>()\[\]{}:;,]/.test(next) ? placeholder : root;
    });
  }
  return text;
}
