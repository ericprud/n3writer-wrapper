/**
 * n3writer-wrapper
 *
 * Helpers that improve the readability of Turtle/TriG output from n3.Writer:
 *
 *   topoWrite(writer, quads)  — feed quads to an N3 Writer using nested [ ]
 *                               notation for blank nodes that appear as an
 *                               object exactly once (tree-edge inlining).
 *
 *   reindent(turtle, step?)   — post-process a Turtle/TriG string so that
 *                               predicate-continuation lines use `step`
 *                               (default 2 spaces) instead of n3.Writer's
 *                               hard-coded 4, and blank-node content at depth
 *                               d uses step × (d+1).
 *
 *   expandLiterals(turtle)    — convert STRING_LITERAL2 values containing \n
 *                               into STRING_LITERAL_LONG2 ("""…""") with a
 *                               real embedded newline.
 */

/** Minimal structural interface for terms (compatible with n3, rdfjs, graphy). */
export interface RdfTerm {
  termType: string;
  value: string;
  datatype?: { value: string };
  language?: string;
}

/** Minimal structural interface for quads. */
export interface RdfQuad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
  graph: RdfTerm;
}

/**
 * Minimal structural interface for the n3.Writer methods that topoWrite uses.
 * Any object that provides blank() and addQuad() with these signatures works.
 */
export interface TurtleWriter {
  blank(predicates?: Array<{ predicate: RdfTerm; object: unknown }>): unknown;
  addQuad(subject: RdfTerm, predicate: RdfTerm, object: unknown, graph?: RdfTerm): void;
}

/**
 * Write quads to an N3 Writer using nested [ ] notation for blank nodes that
 * appear as an object exactly once (sole child in a tree edge).  Blank nodes
 * used more than once as objects, or that have no subject triples, fall back
 * to the normal _:label reference.  CONSTRUCT-style duplicate quads are
 * deduplicated before processing.
 */
export function topoWrite(writer: TurtleWriter, quads: Iterable<RdfQuad>): void {
  const termKey = (t: RdfTerm): string =>
    t.termType === 'Literal'
      ? `L\0${t.value}\0${t.datatype?.value ?? ''}\0${t.language ?? ''}`
      : `${t.termType[0]}\0${t.value}`;

  const seen = new Set<string>();
  const deduped = [...quads].filter(q => {
    const k = `${termKey(q.graph)}\0${termKey(q.subject)}\0${q.predicate.value}\0${termKey(q.object)}`;
    return seen.size !== seen.add(k).size;
  });

  // Index quads by (graph, subject); count blank-node object occurrences per graph.
  const bySub = new Map<string, { term: RdfTerm; graph: RdfTerm; pos: RdfQuad[] }>();
  const oCount = new Map<string, number>();

  for (const q of deduped) {
    const k = `${q.graph.value}\0${q.subject.termType}\0${q.subject.value}`;
    if (!bySub.has(k)) bySub.set(k, { term: q.subject, graph: q.graph, pos: [] });
    bySub.get(k)!.pos.push(q);
    if (q.object.termType === 'BlankNode') {
      const ok = `${q.graph.value}\0${q.object.value}`;
      oCount.set(ok, (oCount.get(ok) ?? 0) + 1);
    }
  }

  const inlineable = (bn: RdfTerm, graph: RdfTerm): boolean =>
    oCount.get(`${graph.value}\0${bn.value}`) === 1 &&
    bySub.has(`${graph.value}\0BlankNode\0${bn.value}`);

  function buildBlank(bn: RdfTerm, graph: RdfTerm): unknown {
    const entry = bySub.get(`${graph.value}\0BlankNode\0${bn.value}`);
    if (!entry) return writer.blank();
    return writer.blank(
      entry.pos.map(q => ({
        predicate: q.predicate,
        object:
          q.object.termType === 'BlankNode' && inlineable(q.object, graph)
            ? buildBlank(q.object, graph)
            : q.object,
      })),
    );
  }

  for (const { term, graph, pos } of bySub.values()) {
    if (term.termType === 'BlankNode' && inlineable(term, graph)) continue;
    for (const q of pos) {
      writer.addQuad(
        q.subject,
        q.predicate,
        q.object.termType === 'BlankNode' && inlineable(q.object, graph)
          ? buildBlank(q.object, graph)
          : q.object,
        q.graph,
      );
    }
  }
}

/**
 * Post-process an N3.js Writer Turtle/TriG string with uniform indentation.
 *
 * n3.Writer uses 4 spaces for predicate-continuation lines and 2 spaces inside
 * blank-node [ ] blocks.  reindent normalises this so that each additional level
 * of [ ] nesting adds exactly one `step` (default: 2 spaces).
 */
export function reindent(turtle: string, step = '  '): string {
  let depth = 0;
  return turtle
    .split('\n')
    .map(line => {
      const t = line.trimStart();
      if (!t) return '';

      // Leading ] chars close blocks: reduce depth before outputting this line.
      let leading = 0;
      while (leading < t.length && t[leading] === ']') {
        depth = Math.max(0, depth - 1);
        leading++;
      }

      let out: string;
      if (depth > 0) {
        out = step.repeat(depth + 1) + t;
      } else if (leading > 0 || line !== t) {
        out = step + t;
      } else {
        out = line.trimEnd();
      }

      // Count net unbalanced [ brackets outside string literals to track depth.
      if (t.trimEnd().endsWith('[')) {
        let opens = 0,
          closes = 0,
          inStr = false,
          i = 0;
        while (i < t.length) {
          const c = t[i];
          if (c === '\\' && inStr) {
            i += 2;
            continue;
          }
          if (c === '"') inStr = !inStr;
          else if (!inStr) {
            if (c === '[') opens++;
            else if (c === ']') closes++;
          }
          i++;
        }
        const netOpen = opens - closes + leading;
        if (netOpen > 0) depth += netOpen;
      }

      return out;
    })
    .join('\n');
}

/**
 * Replace STRING_LITERAL2 values that contain the \n escape sequence with
 * STRING_LITERAL_LONG2 (triple-quoted) with a real embedded newline.
 *
 * Falls back to the original form if the expanded content contains """ (which
 * cannot appear unescaped inside a long literal).
 */
export function expandLiterals(turtle: string): string {
  return turtle.replace(/"((?:[^"\\]|\\.)*)"/g, (match, content: string) => {
    if (!content.includes('\\n')) return match;
    const expanded = content.replace(/\\n/g, '\n');
    if (expanded.includes('"""')) return match;
    return `"""${expanded}"""`;
  });
}
