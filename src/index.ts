/**
 * n3writer-wrapper
 *
 * Helpers that improve the readability of Turtle/TriG output from n3.Writer:
 *
 *   topoWrite(writer, quads)  — feed quads to an N3 Writer using nested [ ]
 *                               notation for blank nodes that appear as an
 *                               object exactly once (tree-edge inlining), and
 *                               ( ) notation for RDF Collections.
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
 * Any object that provides blank(), list(), and addQuad() with these signatures works.
 */
export interface TurtleWriter {
  blank(predicates?: Array<{ predicate: RdfTerm; object: unknown }>): unknown;
  list(elements: unknown[]): unknown;
  addQuad(subject: RdfTerm, predicate: RdfTerm, object: unknown, graph?: RdfTerm): void;
}

const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

/**
 * Write quads to an N3 Writer using:
 *   - ( ) notation for RDF Collections (rdf:first / rdf:rest chains)
 *   - [ ] notation for blank nodes that appear as an object exactly once
 *   - _:label references for blank nodes used more than once
 *
 * CONSTRUCT-style duplicate quads are deduplicated before processing.
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

  // ── RDF Collection detection ──────────────────────────────────────────────
  // Blank nodes that appear as rdf:rest values are non-head list nodes.
  const isListRestNode = new Set<string>();
  for (const q of deduped) {
    if (q.predicate.value === RDF_REST && q.object.termType === 'BlankNode')
      isListRestNode.add(q.object.value);
  }

  // Walk each list head to collect ordered items; record all list-node BN IDs.
  const listItems = new Map<string, { items: RdfTerm[]; graph: RdfTerm }>();
  const listNodeIds = new Set<string>();

  for (const q of deduped) {
    if (q.predicate.value !== RDF_FIRST || q.subject.termType !== 'BlankNode') continue;
    if (isListRestNode.has(q.subject.value)) continue; // not a head
    const headId = q.subject.value;
    if (listItems.has(headId)) continue;
    const graph = q.graph;
    const items: RdfTerm[] = [];
    let curId = headId;
    walk: while (true) {
      listNodeIds.add(curId);
      let first: RdfTerm | undefined;
      let nextId: string | null = null;
      for (const qq of deduped) {
        if (qq.subject.termType !== 'BlankNode' || qq.subject.value !== curId) continue;
        if (qq.predicate.value === RDF_FIRST) first = qq.object;
        if (qq.predicate.value === RDF_REST) {
          nextId = qq.object.termType === 'BlankNode' ? qq.object.value : null;
        }
      }
      if (!first) break walk;
      items.push(first);
      if (nextId === null) break walk;
      curId = nextId;
    }
    listItems.set(headId, { items, graph });
  }

  // ── Normal (non-list-node) quad processing ────────────────────────────────
  // Exclude quads whose subject is a list node; they are encoded via writer.list().
  const normalQuads = deduped.filter(
    q => !(q.subject.termType === 'BlankNode' && listNodeIds.has(q.subject.value)),
  );

  // Index by (graph, subject); count BN object occurrences per graph.
  const bySub = new Map<string, { term: RdfTerm; graph: RdfTerm; pos: RdfQuad[] }>();
  const oCount = new Map<string, number>();

  for (const q of normalQuads) {
    const k = `${q.graph.value}\0${q.subject.termType}\0${q.subject.value}`;
    if (!bySub.has(k)) bySub.set(k, { term: q.subject, graph: q.graph, pos: [] });
    bySub.get(k)!.pos.push(q);
    if (q.object.termType === 'BlankNode') {
      const ok = `${q.graph.value}\0${q.object.value}`;
      oCount.set(ok, (oCount.get(ok) ?? 0) + 1);
    }
  }

  // List items referenced via rdf:first are single-use objects excluded from
  // normalQuads; add them to oCount so blank-node items remain inlineable.
  for (const { items, graph } of listItems.values()) {
    for (const item of items) {
      if (item.termType === 'BlankNode') {
        const ok = `${graph.value}\0${item.value}`;
        oCount.set(ok, (oCount.get(ok) ?? 0) + 1);
      }
    }
  }

  const inlineable = (bn: RdfTerm, graph: RdfTerm): boolean =>
    !listNodeIds.has(bn.value) &&
    oCount.get(`${graph.value}\0${bn.value}`) === 1 &&
    bySub.has(`${graph.value}\0BlankNode\0${bn.value}`);

  function buildObject(obj: RdfTerm, graph: RdfTerm): unknown {
    if (obj.termType !== 'BlankNode') return obj;
    const listEntry = listItems.get(obj.value);
    if (listEntry)
      return writer.list(listEntry.items.map(item => buildObject(item, listEntry.graph)));
    if (inlineable(obj, graph)) return buildBlank(obj, graph);
    return obj;
  }

  function buildBlank(bn: RdfTerm, graph: RdfTerm): unknown {
    const entry = bySub.get(`${graph.value}\0BlankNode\0${bn.value}`);
    if (!entry) return writer.blank();
    return writer.blank(
      entry.pos.map(q => ({
        predicate: q.predicate,
        object: buildObject(q.object, graph),
      })),
    );
  }

  for (const { term, graph, pos } of bySub.values()) {
    if (term.termType === 'BlankNode' && inlineable(term, graph)) continue;
    for (const q of pos) {
      writer.addQuad(
        q.subject,
        q.predicate,
        buildObject(q.object, graph),
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
