import { closingBracket } from '../files.ts';

/** A decorator of TypeScript or an annotation of Java and Kotlin: `@Name(args)` or `@Name`. */
export interface Decorator {
  name: string;
  args: string;
  start: number;
  end: number;
}

/** Every decorator of a source in order, arguments balanced; what is inside another's arguments is not one. */
export function decoratorsOf(src: string): Decorator[] {
  const out: Decorator[] = [];
  const re = /@([A-Za-z_$][\w$]*)\s*(\()?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1] as string;
    if (!m[2]) {
      out.push({ name, args: '', start: m.index, end: m.index + m[0].length });
      continue;
    }
    const open = m.index + m[0].length - 1;
    const close = closingBracket(src, open);
    out.push({ name, args: src.slice(open + 1, close), start: m.index, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

/** The decorators of one class or member: those with nothing but white space between them. */
export function blocksOf(src: string): Decorator[][] {
  const blocks: Decorator[][] = [];
  let previous: Decorator | undefined;
  for (const d of decoratorsOf(src)) {
    if (previous && src.slice(previous.end, d.start).trim() === '') (blocks[blocks.length - 1] as Decorator[]).push(d);
    else blocks.push([d]);
    previous = d;
  }
  return blocks;
}
