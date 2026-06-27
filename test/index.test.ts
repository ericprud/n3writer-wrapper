import { describe, it, expect } from 'vitest';
import { Writer, Parser, Store } from 'n3';
import { topoWrite, reindent, expandLiterals } from '../src/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function parseTurtle(ttl: string) {
  const store = new Store();
  const parser = new Parser({ format: 'Turtle' });
  store.addQuads(parser.parse(ttl));
  return store;
}

async function writeTurtle(
  store: Store,
  prefixes: Record<string, string> = {},
): Promise<string> {
  const writer = new Writer({ format: 'Turtle', prefixes });
  topoWrite(writer, store.getQuads(null, null, null, null));
  return new Promise((resolve, reject) =>
    writer.end((err, result) => (err ? reject(err) : resolve(result))),
  );
}

// Round-trip: parse → topoWrite → parse; check quad count is preserved.
async function roundTrip(ttl: string, prefixes: Record<string, string> = {}) {
  const store = parseTurtle(ttl);
  const out = await writeTurtle(store, prefixes);
  const reparsed = parseTurtle(out);
  return { original: store, out, reparsed };
}

// ── FHIR Turtle fixtures (derived from rdf-sig-playground/examples/toy.yaml) ─

const FHIR_PFX = {
  fhir: 'http://hl7.org/fhir/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

/**
 * Simplified FHIR Bundle with deeply-nested blank nodes.
 * Mirrors the structure used in toy.yaml's fhirBundleGraph.
 */
const FHIR_BUNDLE = `
  PREFIX fhir: <http://hl7.org/fhir/>
  PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
  PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

  <http://hl7.org/fhir/Bundle/signed> a fhir:Bundle ;
    fhir:id [ fhir:v "signed" ] ;
    fhir:type [ fhir:v "collection" ] ;
    fhir:timestamp [ fhir:v "2024-06-09T11:06:35+10:00"^^xsd:dateTime ] ;
    fhir:entry ( [
      fhir:fullUrl [ fhir:v "http://something5"^^xsd:anyURI ] ;
      fhir:resource ( <http://something5> )
    ] ) .

  <http://something5> a fhir:Observation ;
    fhir:id [ fhir:v "obs1" ] ;
    fhir:status [ fhir:v "final" ] ;
    fhir:code [ fhir:text [ fhir:v "something" ] ] .
`;

/**
 * FHIR Provenance that co-signs the Bundle (toy.yaml's withProof for fhirProvenance).
 * The fhir:signature blank node is single-use → topoWrite should inline it.
 */
const FHIR_PROVENANCE = `
  PREFIX fhir: <http://hl7.org/fhir/>
  PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>

  <http://something4> a fhir:Provenance ;
    fhir:id [ fhir:v "prov1" ] ;
    fhir:target [ fhir:reference [ fhir:v "Bundle/signed" ] ] ;
    fhir:recorded [ fhir:v "2024-06-09T11:06:35+10:00"^^xsd:dateTime ] ;
    fhir:signature [
      fhir:when [ fhir:v "2024-06-09T11:06:35+10:00"^^xsd:dateTime ] ;
      fhir:who  [ fhir:reference [ fhir:v "Organization/ig-publisher" ] ] ;
      fhir:sigFormat [ fhir:v "application/jose" ] ;
      fhir:data  [ fhir:v "eyJhbGciOiJSUzI1NiIsImI2NCI6ZmFsc2UsImNyaXQiOlsiYjY0Il19..stub" ]
    ] .
`;

// ── topoWrite ─────────────────────────────────────────────────────────────────

describe('topoWrite', () => {
  it('preserves quad count on round-trip (FHIR Bundle)', async () => {
    const { original, reparsed } = await roundTrip(FHIR_BUNDLE, FHIR_PFX);
    expect(reparsed.size).toBe(original.size);
  });

  it('preserves quad count on round-trip (FHIR Provenance)', async () => {
    const { original, reparsed } = await roundTrip(FHIR_PROVENANCE, FHIR_PFX);
    expect(reparsed.size).toBe(original.size);
  });

  it('inlines single-use blank nodes as [ ] (FHIR fhir:id pattern)', async () => {
    const { out } = await roundTrip(FHIR_BUNDLE, FHIR_PFX);
    // fhir:id [ fhir:v "signed" ] should appear as an inline blank
    expect(out).toMatch(/fhir:id\s+\[/);
    // No _:b labels for single-use blank nodes
    expect(out).not.toMatch(/_:b\d/);
  });

  it('inlines deeply nested blank nodes (fhir:code [ fhir:text [ … ] ])', async () => {
    const { out } = await roundTrip(FHIR_BUNDLE, FHIR_PFX);
    // fhir:code followed by a [ somewhere on the same or next line
    expect(out).toMatch(/fhir:code\s+\[/);
  });

  it('inlines fhir:signature with nested fhir:data [ fhir:v "…" ]', async () => {
    const { out } = await roundTrip(FHIR_PROVENANCE, FHIR_PFX);
    expect(out).toMatch(/fhir:signature\s+\[/);
    expect(out).toMatch(/fhir:data\s+\[/);
  });

  it('deduplicates repeated quads', async () => {
    const ttl = `PREFIX ex: <http://example.org/> ex:s ex:p ex:o .`;
    const quads = parseTurtle(ttl).getQuads(null, null, null, null);
    // Pass the same quad twice — n3 Store already deduplicates so we bypass it
    const duped = [...quads, ...quads];
    const writer = new Writer({ format: 'Turtle', prefixes: { ex: 'http://example.org/' } });
    topoWrite(writer, duped);
    const out = await new Promise<string>((res, rej) =>
      writer.end((e, r) => (e ? rej(e) : res(r))),
    );
    const matches = out.match(/ex:p/g);
    expect(matches).toHaveLength(1);
  });

  it('keeps multi-use blank nodes as _: references', async () => {
    // _:shared is the object of two triples → must NOT be inlined
    const ttl = `
      PREFIX ex: <http://example.org/>
      ex:a ex:ref _:shared .
      ex:b ex:ref _:shared .
      _:shared ex:label "x" .
    `;
    const { out } = await roundTrip(ttl);
    expect(out).toMatch(/_:/); // _:shared must remain explicit
  });
});

// ── reindent ──────────────────────────────────────────────────────────────────

describe('reindent', () => {
  it('converts 4-space predicate continuation to 2-space', () => {
    // n3.Writer emits 4 spaces before predicate continuations
    const raw = '<http://ex/s> <http://ex/p1> "a" ;\n    <http://ex/p2> "b" .';
    const out = reindent(raw);
    expect(out).toContain('\n  <http://ex/p2>');
  });

  it('normalises blank-node block indentation', () => {
    const raw = '<http://ex/s> <http://ex/p> [\n  <http://ex/q> "v"\n] .';
    const out = reindent(raw);
    // Content inside [ ] should be indented by 2*2 = 4 spaces (step*(depth+1)=2*2)
    expect(out).toMatch(/\n {4}<http:\/\/ex\/q>/);
  });

  it('leaves subject lines unindented', () => {
    const raw = '<http://ex/s> <http://ex/p> "v" .';
    expect(reindent(raw)).toBe(raw);
  });

  it('handles real FHIR bundle output end-to-end', async () => {
    const store = parseTurtle(FHIR_BUNDLE);
    const writer = new Writer({ format: 'Turtle', prefixes: FHIR_PFX });
    topoWrite(writer, store.getQuads(null, null, null, null));
    const raw = await new Promise<string>((res, rej) =>
      writer.end((e, r) => (e ? rej(e) : res(r))),
    );
    const out = reindent(raw);
    // Re-parse to confirm semantics preserved
    expect(parseTurtle(out).size).toBe(store.size);
    // Depth-0 predicate continuations should use 2 spaces, not n3's default 4.
    // (Depth-1 content legitimately has 4 spaces = step*(1+1); don't count those.)
    const raw4 = raw.split('\n').filter(l => /^ {4}\S/.test(l));
    const out4 = out.split('\n').filter(l => /^ {4}\S/.test(l));
    // reindent must reduce the number of 4-space-leading lines
    expect(out4.length).toBeLessThan(raw4.length);
  });

  it('accepts a custom step', () => {
    const raw = '<http://ex/s> <http://ex/p1> "a" ;\n    <http://ex/p2> "b" .';
    const out = reindent(raw, '\t');
    expect(out).toContain('\n\t<http://ex/p2>');
  });
});

// ── expandLiterals ────────────────────────────────────────────────────────────

describe('expandLiterals', () => {
  it('converts \\n escape to real newline in double-quoted string', () => {
    const out = expandLiterals('"line1\\nline2"');
    expect(out).toBe('"""line1\nline2"""');
  });

  it('leaves strings without \\n unchanged', () => {
    expect(expandLiterals('"hello world"')).toBe('"hello world"');
  });

  it('leaves already-triple-quoted strings unchanged', () => {
    // The regex only matches double-quoted (not triple-quoted) literals,
    // so existing """...""" blocks pass through untouched.
    const src = '"""line1\nline2"""';
    expect(expandLiterals(src)).toBe(src);
  });

  it('handles FHIR xhtml narrative with embedded \\n', () => {
    const ttl = `fhir:div [ fhir:v "<div>\\nstuff</div>" ] .`;
    const out = expandLiterals(ttl);
    expect(out).toContain('"""<div>\nstuff</div>"""');
  });

  it('handles multiple literals in one string', () => {
    const ttl = `ex:a "first\\nsecond" ; ex:b "no newline" ; ex:c "third\\nfourth" .`;
    const out = expandLiterals(ttl);
    expect(out).toContain('"""first\nsecond"""');
    expect(out).toContain('"no newline"');
    expect(out).toContain('"""third\nfourth"""');
  });
});
