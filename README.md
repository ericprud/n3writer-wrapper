# n3writer-wrapper

Helpers that improve the readability of [n3.js](https://github.com/rdfjs/N3.js) Turtle/TriG output:

| Function | What it does |
|---|---|
| `topoWrite(writer, quads)` | Feeds quads to an N3 Writer using nested `[ ]` notation for blank nodes that appear as an object exactly once |
| `reindent(turtle, step?)` | Normalises n3.Writer's mixed 4-space/2-space indentation to a uniform `step` (default: 2 spaces) at every nesting depth |
| `expandLiterals(turtle)` | Converts `"string\nwith\nescapes"` to `"""string`<br>`with`<br>`newlines"""` for readability |

## Install

```sh
npm install n3writer-wrapper
```

n3 itself is a peer dependency (optional — the structural types mean any compatible writer works):

```sh
npm install n3
```

## Usage

```ts
import { Writer } from 'n3';
import { topoWrite, reindent, expandLiterals } from 'n3writer-wrapper';

const writer = new Writer({ format: 'Turtle', prefixes: { ex: 'http://example.org/' } });
topoWrite(writer, quads);
const turtle = await new Promise<string>((resolve, reject) =>
  writer.end((err, result) => (err ? reject(err) : resolve(result)))
);
const pretty = expandLiterals(reindent(turtle));
```

### `topoWrite(writer, quads)`

Blank nodes that appear as an object **exactly once** are inlined as `[ ]` blocks.
Blank nodes used more than once, or with no outgoing triples, fall back to `_:label` references.
Duplicate quads (e.g. from a SPARQL CONSTRUCT) are silently deduplicated.

Input quads can be any iterable of [RDFJS](https://rdf.js.org/data-model-spec/)-compatible quads (n3, graphy, etc.).

### `reindent(turtle, step = '  ')`

n3.Writer hard-codes 4 spaces for predicate-continuation lines and 2 spaces inside `[ ]` blocks.
`reindent` normalises this so each additional nesting level adds exactly one `step`:

```
# before                          # after (step = '  ')
<ex:s> ex:p1 "a" ;                <ex:s> ex:p1 "a" ;
    ex:p2 [                         ex:p2 [
      ex:q "v"                          ex:q "v"
    ] .                             ] .
```

### `expandLiterals(turtle)`

Converts `\n` escape sequences inside double-quoted literals to real newlines using triple-quoted form:

```
"line1\nline2"  →  """line1
                   line2"""
```

Falls back to the original form if the expanded content would contain `"""`.

## TypeScript

The package ships with declarations. The `TurtleWriter` interface is structural, so it matches `n3.Writer` without importing n3 as a type dependency:

```ts
import type { TurtleWriter, RdfQuad } from 'n3writer-wrapper';
```

## License

MIT
