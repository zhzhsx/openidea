/**
 * Go's semantic highlighting beyond the LSP tokens (GoLand's category colours):
 * calls split by visibility (exported / package-local / predeclared), type
 * references, package qualifiers, method receivers, variables that shadow one
 * from an enclosing scope, and identifiers a comment names.
 */
import type { SyntaxNode, Tree } from "@lezer/common";
import type { Text } from "@codemirror/state";
import type { SemanticRange } from "../languages";

export type GoKind =
  | "builtinCall"
  | "exportedCall"
  | "localCall"
  | "type"
  | "package"
  | "receiver"
  | "shadowing"
  | "commentReference";

const CLASSES: Record<GoKind, string> = {
  builtinCall: "cm-sem-go-builtin",
  exportedCall: "cm-sem-go-call-exported",
  localCall: "cm-sem-go-call-local",
  type: "cm-sem-go-type",
  package: "cm-sem-go-package",
  receiver: "cm-sem-go-receiver",
  shadowing: "cm-sem-go-shadowing",
  commentReference: "cm-sem-go-comment-ref",
};

/** Predeclared functions and types; GoLand colours both as built-ins. */
const BUILTIN_FUNCTIONS = new Set([
  "append",
  "cap",
  "clear",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "max",
  "min",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
]);
const BUILTIN_TYPES = new Set([
  "any",
  "bool",
  "byte",
  "comparable",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMENT = new Set(["LineComment", "BlockComment"]);
const FUNCTION = new Set(["FunctionDecl", "MethodDecl", "FunctionLiteral"]);

const exported = (name: string) => /^[A-Z]/.test(name);

/** The next non-blank character, which tells a call (`f(`) from a reference. */
function nextChar(doc: Text, pos: number): string {
  if (pos >= doc.length) return "";
  const match = /^[ \t]*([^ \t])/.exec(doc.sliceString(pos, Math.min(doc.length, pos + 16)));
  return match?.[1] ?? "";
}

function each(node: SyntaxNode, visit: (node: SyntaxNode) => void) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    visit(child);
    each(child, visit);
  }
}

/** Import aliases, or the path's last segment: the names a selector's base can be. */
function importPackages(tree: Tree, doc: Text): Set<string> {
  const names = new Set<string>();
  tree.iterate({
    enter(ref) {
      if (ref.name !== "ImportSpec") return;
      const alias = ref.node.getChild("DefName");
      if (alias) {
        const name = doc.sliceString(alias.from, alias.to);
        if (name !== "_" && name !== ".") names.add(name);
        return;
      }
      const path = ref.node.getChild("String");
      if (!path) return;
      const segments = doc
        .sliceString(path.from, path.to)
        .replace(/^[`"]|[`"]$/g, "")
        .split("/");
      const last = segments[segments.length - 1];
      if (last && IDENTIFIER.test(last)) names.add(last);
    },
  });
  return names;
}

/** The receiver of a method declaration (`func (s *Store) M()` → `s`). */
function receiverOf(node: SyntaxNode, doc: Text): { name: string; from: number; to: number } | null {
  const name = node.getChild("Parameters")?.getChild("Parameter")?.getChild("DefName");
  if (!name) return null;
  return { name: doc.sliceString(name.from, name.to), from: name.from, to: name.to };
}

/** Blocks whose nearest enclosing block is `block`. */
function blocksIn(block: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const walk = (node: SyntaxNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "Block") out.push(child);
      else if (!FUNCTION.has(child.name)) walk(child);
    }
  };
  walk(block);
  return out;
}

/** Declarations made directly in `block`, not in one of its nested blocks. */
function declarationsIn(block: SyntaxNode, doc: Text): Array<{ name: string; from: number; to: number }> {
  const out: Array<{ name: string; from: number; to: number }> = [];
  const walk = (node: SyntaxNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "Block" || FUNCTION.has(child.name)) continue;
      if (child.name === "DefName") {
        const name = doc.sliceString(child.from, child.to);
        if (IDENTIFIER.test(name)) out.push({ name, from: child.from, to: child.to });
      }
      walk(child);
    }
  };
  walk(block);
  return out;
}

/**
 * A declaration that reuses a name from the function's parameters or an
 * enclosing block hides it; GoLand colours that variable to flag the shadowing.
 */
function visitBlock(
  block: SyntaxNode,
  outer: Array<Set<string>>,
  doc: Text,
  add: (from: number, to: number, kind: GoKind) => void,
) {
  const locals = new Set<string>();
  for (const decl of declarationsIn(block, doc)) {
    if (decl.name !== "_" && outer.some((names) => names.has(decl.name))) {
      add(decl.from, decl.to, "shadowing");
      each(block, (node) => {
        if (node.name === "VariableName" && node.from > decl.to && doc.sliceString(node.from, node.to) === decl.name)
          add(node.from, node.to, "shadowing");
      });
    }
    locals.add(decl.name);
  }
  for (const nested of blocksIn(block)) visitBlock(nested, [...outer, locals], doc, add);
}

export function goSyntaxRanges(tree: Tree, doc: Text): SemanticRange[] {
  const out: SemanticRange[] = [];
  const seen = new Set<string>();
  const add = (from: number, to: number, kind: GoKind) => {
    const key = `${from}:${to}`;
    if (from >= to || seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, className: CLASSES[kind] });
  };

  const packages = importPackages(tree, doc);
  /** Names a comment can refer to (the parse tree declares them all). */
  const declared = new Set<string>();

  tree.iterate({
    enter(ref) {
      const node = ref.node;
      const text = doc.sliceString(ref.from, ref.to);

      if (ref.name === "TypeName") {
        add(ref.from, ref.to, BUILTIN_TYPES.has(text) ? "builtinCall" : "type");
        return;
      }
      if (ref.name === "DefName") {
        if (IDENTIFIER.test(text) && text !== "_") declared.add(text);
        return;
      }
      if (ref.name === "MethodDecl") {
        const name = node.getChild("FieldName");
        if (name) declared.add(doc.sliceString(name.from, name.to));
        const receiver = receiverOf(node, doc);
        if (receiver) {
          declared.add(receiver.name);
          add(receiver.from, receiver.to, "receiver");
          const body = node.getChild("Block");
          if (body)
            each(body, (child) => {
              if (child.name === "VariableName" && doc.sliceString(child.from, child.to) === receiver.name)
                add(child.from, child.to, "receiver");
            });
        }
        return;
      }
      if (ref.name === "FunctionDecl" || ref.name === "TypeSpec") {
        const name = ref.name === "TypeSpec" ? node.getChild("DefName") : node.getChild("FieldName");
        if (name) declared.add(doc.sliceString(name.from, name.to));
        return;
      }
      if (ref.name !== "VariableName" && ref.name !== "FieldName") return;
      if (!IDENTIFIER.test(text)) return;
      const parent = node.parent?.name;
      // `func name(...)` is a declaration, not a call.
      if (parent === "FunctionDecl" || parent === "MethodDecl") return;
      const next = nextChar(doc, ref.to);
      if (next === "(") {
        add(
          ref.from,
          ref.to,
          BUILTIN_FUNCTIONS.has(text) ? "builtinCall" : exported(text) ? "exportedCall" : "localCall",
        );
      } else if (next === "." && ref.name === "VariableName" && packages.has(text)) {
        add(ref.from, ref.to, "package");
      }
    },
  });

  if (declared.size)
    tree.iterate({
      enter(ref) {
        if (!COMMENT.has(ref.name)) return;
        for (const match of doc.sliceString(ref.from, ref.to).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          if (!declared.has(match[0])) continue;
          const from = ref.from + (match.index ?? 0);
          add(from, from + match[0].length, "commentReference");
        }
      },
    });

  tree.iterate({
    enter(ref) {
      if (!FUNCTION.has(ref.name)) return;
      const params = new Set<string>();
      for (let child = ref.node.firstChild; child; child = child.nextSibling)
        if (child.name === "Parameters")
          each(child, (node) => {
            if (node.name === "DefName") params.add(doc.sliceString(node.from, node.to));
          });
      const body = ref.node.getChild("Block");
      if (body) visitBlock(body, [params], doc, add);
      return false;
    },
  });

  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
