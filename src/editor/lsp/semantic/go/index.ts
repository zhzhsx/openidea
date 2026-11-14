import { registerLanguageSemantics, type LanguageSemantics } from "../languages";
import { goSyntaxRanges } from "./highlight";

const goSemantics: LanguageSemantics = {
  syntaxRanges: (tree, doc) => goSyntaxRanges(tree, doc),
  tokenClasses({ type, modifiers, classes }) {
    if (type === "variable") {
      if (modifiers.includes("readonly") && !classes.includes("cm-sem-constant")) classes.push("cm-sem-constant");
      else if (modifiers.includes("static") && !classes.includes("cm-sem-constant")) classes.push("cm-sem-global");
    }
  },
  isLocal: ({ type, modifiers }) => type === "parameter" || (type === "variable" && !modifiers.includes("readonly")),
};

registerLanguageSemantics("go", goSemantics);
