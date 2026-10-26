// Mermaid flowchart subset parser. Pure text -> structure; no network, no
// layout. Produces the input for mermaid-layout (which turns it into paint
// rows) and never paints a *wrong* parse: any statement it cannot fully
// decode makes the whole fence decline, and the caller falls back to the
// plain code block — byte-identical to the pre-feature render.
//
// Scope (deliberate, documented): the constructs dominating real mermaid
// flowchart output — header direction (TD/TB/LR/RL/BT), chained edges with
// solid/dotted/thick strokes, edge labels (`-- x -->`, `-->|x|`), node
// shapes ([rect] (round) ([stadium]) ((circle)) {diamond}), o/x end marks,
// `~~~` invisible links. `classDef|class|style|linkStyle|click|direction`
// lines and `%%` comments are skipped as decoration (decision recorded
// here, not silently). Subgraphs / sequence / class / state / pie / gantt
// diagrams decline: they need their own layout rules and pretending them
// into boxes would lie about the source.
export type NodeShape = "plain" | "rect" | "round" | "stadium" | "circle" | "diamond";

export type FlowNode = { id: string; label: string; shape: NodeShape };

export type Stroke = "solid" | "dotted" | "thick";

export type FlowEdge = {
  from: string;
  to: string;
  stroke: Stroke;
  arrow: boolean;
  /** `~~~` invisible link: connectivity only, never painted. */
  ghost?: boolean;
  startMark?: "o" | "x";
  endMark?: "o" | "x";
  label?: string;
};

export type ParsedFlow = {
  vertical: boolean; // TD/TB/BT stack top-down; LR/RL run left-to-right
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export function parseFlowchart(text: string): ParsedFlow | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const header = lines.find((l) => l.length > 0 && !l.startsWith("%%"));
  if (!header) return null;
  const dir = header.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/i);
  if (!dir) return null;
  if (/\b(subgraph|sequenceDiagram|classDiagram|stateDiagram|pie|gantt)\b/i.test(text)) {
    return null;
  }
  const dirToken = dir[1]!.toUpperCase();
  const vertical = dirToken !== "LR" && dirToken !== "RL";

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  for (const raw of lines) {
    if (raw.length === 0 || raw.startsWith("%%")) continue;
    if (/^(?:classDef\s|class\s|style\s|linkStyle\s|click\s|direction\s)/.test(raw)) continue;
    if (raw === header) continue;
    if (!parseChain(flattenStatement(raw), nodes, edges)) return null;
  }
  if (nodes.size === 0) return null;
  if (edges.length === 0 && nodes.size > 1) {
    // Multi-node with no edges declines: a stack of floating boxes is a
    // worse picture than the source text. A lone node paints as a box.
    return null;
  }
  return { vertical, nodes: [...nodes.values()], edges };
}

// Semicolons are statement separators in mermaid; they never carry meaning
// inside labels people actually write — treat them as whitespace.
function flattenStatement(raw: string): string {
  return raw.replace(/;/g, " ");
}

// One statement: nodeRef (edgeOp nodeRef)*. Leftover junk rejects the line.
function parseChain(
  line: string,
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
): boolean {
  const node = readNode(line, 0);
  if (!node) return false;
  rememberNode(nodes, node);
  let cur = node;
  for (;;) {
    let p = skipWs(line, cur.next);
    if (p >= line.length) return true;
    const head = readMark(line, p);
    const scan = readEdgeOperator(line, head.next);
    if (!scan) return false;
    p = skipWs(line, scan.next);
    const endMark = readMark(line, p);
    p = skipWs(line, endMark.next);
    const target = readNode(line, p);
    if (!target) return false;
    rememberNode(nodes, target);
    edges.push({
      from: cur.id,
      to: target.id,
      stroke: scan.stroke,
      arrow: scan.arrow,
      label: scan.label,
      startMark: head.mark,
      endMark: endMark.mark,
    });
    cur = target;
  }
}

function skipWs(s: string, p: number): number {
  while (p < s.length && /\s/.test(s[p]!)) p += 1;
  return p;
}

// Marks glue to the operator in mermaid (`o--`, `x-->`, `--o`). A bare `o`
// followed by whitespace is a node id, never a mark — the abut check below
// keeps node ids like `o`, `o1` readable where they are ids.
function readMark(s: string, p: number): { mark?: "o" | "x"; next: number } {
  const c = s[p];
  if ((c === "o" || c === "x") && /^[-=.]/.test(s[p + 1] ?? "")) {
    return { mark: c, next: p + 1 };
  }
  return { next: p };
}

function rememberNode(
  nodes: Map<string, FlowNode>,
  n: { id: string; shape: NodeShape; label: string | null },
): void {
  if (n.label !== null && n.label.length > 0) {
    nodes.set(n.id, { id: n.id, label: n.label, shape: n.shape });
  } else if (!nodes.has(n.id)) {
    nodes.set(n.id, { id: n.id, label: n.id, shape: "plain" });
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'");
}

// Node occurrence: `\w+` plus optional shape brackets (longest forms first).
// Bracketed labels plain-read to the closer; labels containing square
// brackets are out of the subset and decline. `~~~`-style invisible links
// sit inside the edge tables below, not the node grammar.
type NodeRef = { id: string; shape: NodeShape; label: string | null; next: number };

const SHAPE_FORMS: [RegExp, NodeShape][] = [
  [/^\(\(\s*(.*?)\s*\)\)/, "circle"],
  [/^\(\[\s*(.*?)\s*\]\)/, "stadium"],
  [/^\[\s*([^\[\]]*?)\s*\]/, "rect"],
  [/^\{\s*(.*?)\s*\}/, "diamond"],
  [/^\(\s*(.*?)\s*\)/, "round"],
];

function readNode(s: string, pos: number): NodeRef | null {
  let p = pos;
  let id = "";
  while (p < s.length && /\w/.test(s[p]!)) {
    id += s[p];
    p += 1;
  }
  if (id.length === 0) return null;
  const rest = s.slice(p);
  for (const [re, shape] of SHAPE_FORMS) {
    const m = rest.match(re);
    if (m) {
      return { id, shape, label: decodeEntities(m[1]!.trim()), next: p + m[0].length };
    }
  }
  return { id, shape: "plain", label: null, next: p };
}

type EdgeShot = { stroke: Stroke; arrow: boolean; label?: string; ghost?: boolean; next: number };

// The operator grammar this parser accepts:
//   solid:  -->   ---   -- text -->   -->|text|
//   thick:  ==>   ===   == text ==>   ==>|text|
//   dotted: -.->  -.-  -. text .->   -.->|text|
//   none:   ~~~
// o/x marks are read by readMark around the operator, not here.
function readEdgeOperator(s: string, pos: number): EdgeShot | null {
  const c = s[pos];
  if (c === undefined) return null;

  // `~~~` invisible link: renders nothing — carried as a ghost edge so
  // layout knows to skip it (connectivity still flows through the node).
  if (c === "~") {
    if (s.slice(pos, pos + 3) === "~~~") {
      return { stroke: "dotted", arrow: false, ghost: true, next: pos + 3 };
    }
    return null;
  }

  if (c === "=") {
    let q = pos;
    while (s[q] === "=") q += 1;
    if (q - pos < 2) return null;
    if (s[q] === ">") {
      const pipe = s[q + 1] === "|" ? readPipeLabel(s, q + 1) : null;
      if (pipe === null && s[q + 1] === "|") return null;
      return {
        stroke: "thick",
        arrow: true,
        label: pipe?.label,
        next: pipe ? pipe.next : q + 1,
      };
    }
    if (s[q] === "|") {
      const pipe = readPipeLabel(s, q);
      if (pipe) return { ...pipe, stroke: "thick", arrow: true };
      return null; // `==|junk|` misshape declines
    }
    if (q - pos === 2) {
      const close = s.slice(q).indexOf("==>");
      if (close > 0) {
        const label = s.slice(q, q + close).trim();
        if (label.length > 0 && !/^[=.]+$/.test(label)) {
          return { stroke: "thick", arrow: true, label: decodeEntities(label), next: q + close + 3 };
        }
      }
    }
    return { stroke: "thick", arrow: false, next: q };
  }

  if (c === "-") {
    if (s.slice(pos, pos + 3) === "~~~") {
      return { stroke: "dotted", arrow: false, next: pos + 3 };
    }
    if (s[pos + 1] === ".") {
      // Exact literals only: '.->' arrows, '.' opens, '. text .->' labels.
      if (s.slice(pos, pos + 4) === "-.->") {
        const pipe = s[pos + 4] === "|" ? readPipeLabel(s, pos + 4) : null;
        if (pipe === null && s[pos + 4] === "|") return null;
        return { stroke: "dotted", arrow: true, label: pipe?.label, next: pipe ? pipe.next : pos + 4 };
      }
      if (s.slice(pos, pos + 3) === "-.-") return { stroke: "dotted", arrow: false, next: pos + 3 };
      const close = s.slice(pos + 2).indexOf(".->");
      if (close > 0) {
        const label = s.slice(pos + 2, pos + 2 + close).trim();
        if (label.length > 0) {
          return { stroke: "dotted", arrow: true, label: decodeEntities(label), next: pos + 2 + close + 3 };
        }
      }
      return null;
    }
    let q = pos;
    while (s[q] === "-") q += 1;
    if (s[q] === ">") {
      const pipe = s[q + 1] === "|" ? readPipeLabel(s, q + 1) : null;
      if (pipe === null && s[q + 1] === "|") return null; // `-->|junk|` misshape declines
      return { stroke: "solid", arrow: true, label: pipe?.label, next: pipe ? pipe.next : q + 1 };
    }
    if (q - pos === 2) {
      const close = s.slice(q).indexOf("-->");
      if (close > 0) {
        const label = s.slice(q, q + close).trim();
        // A longer hyphen run misread as a label is re-rejected; only real
        // label text forms a labeled edge.
        if (label.length > 0 && !/^[.]+$/.test(label) && !label.startsWith("-")) {
          return { stroke: "solid", arrow: true, label: decodeEntities(label), next: q + close + 3 };
        }
      }
    }
    return { stroke: "solid", arrow: false, next: q };
  }

  return null;
}

// Trailing `|label|` directly after a closed arrow (`-->|label|`).
function readPipeLabel(s: string, p: number): { arrow: boolean; label?: string; next: number } | null {
  const m = s.slice(p).match(/^\|([^|]*)\|\s*/);
  if (!m) return null;
  const label = m[1]!.trim();
  return { arrow: true, label: label.length > 0 ? decodeEntities(label) : undefined, next: p + m[0].length };
}
