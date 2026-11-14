import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";
import type { EditorDocContext } from "@/editor/api";
import { lspDoc } from "../../lsp";
import { semanticExtension, semanticRanges } from "../index";

const doc = Text.of(["name"]);
describe("Go semantic tokens", () => {
  it.each([
    [["readonly"], ["cm-sem-constant"]],
    [["static"], ["cm-sem-global", "cm-sem-static"]],
    [
      ["readonly", "static"],
      ["cm-sem-constant", "cm-sem-static"],
    ],
    [
      ["constant", "static"],
      ["cm-sem-constant", "cm-sem-static"],
    ],
  ])("classifies variable modifiers %j", (modifiers, classes) => {
    const ranges = semanticRanges(
      doc,
      {
        tokenTypes: ["variable"],
        tokenModifiers: modifiers,
        data: [0, 0, 4, 0, (1 << modifiers.length) - 1],
      },
      false,
      "go",
    );
    expect(ranges[0]?.className.split(" ").sort()).toEqual(classes);
  });

  it("keeps local constants out of rainbow coloring and scopes readonly to Go", () => {
    const tokens = { tokenTypes: ["variable"], tokenModifiers: ["readonly"], data: [0, 0, 4, 0, 1] };
    expect(semanticRanges(doc, tokens, true, "go")[0]?.className).toBe("cm-sem-constant");
    expect(semanticRanges(doc, tokens, false, "typescript")).toEqual([]);
    expect(semanticRanges(doc, { ...tokens, data: [0, 0, 4, 0, 0] }, true, "go")[0]?.className).toContain(
      "cm-sem-rainbow-",
    );
    expect(semanticRanges(doc, { ...tokens, tokenTypes: ["parameter"] }, true, "go")[0]?.className).toContain(
      "cm-sem-rainbow-",
    );
  });

  it("retains package, field and function roles from the common decoder", () => {
    for (const [type, expected] of [
      ["namespace", "cm-sem-namespace"],
      ["property", "cm-sem-property"],
      ["function", "cm-sem-function"],
      ["type", "cm-sem-type"],
      ["typeParameter", "cm-sem-typeParameter"],
    ]) {
      expect(
        semanticRanges(doc, { tokenTypes: [type!], tokenModifiers: [], data: [0, 0, 4, 0, 0] }, false, "go")[0]
          ?.className,
      ).toBe(expected);
    }
  });

  it("leaves branch labels and missing server tokens to syntax highlighting", () => {
    expect(
      semanticRanges(doc, { tokenTypes: ["label"], tokenModifiers: [], data: [0, 0, 4, 0, 0] }, false, "go"),
    ).toEqual([]);
    expect(semanticRanges(doc, { tokenTypes: [], tokenModifiers: [], data: [] }, true, "go")).toEqual([]);
  });
});

const source = `package demo

import (
	"fmt"
	"net/http"
)

type Store struct{ name string }

func (s *Store) Search(q string) int {
	total := 0
	for _, v := range q {
		total += len(v)
	}
	fmt.Println(total)
	_ = http.StatusOK
	return helper(total) + s.Count()
}

func helper(n int) int { return n }

// Search shows how q shadows the parameter below.
func shadow(q int) {
	if q := 1; q > 0 {
		_ = q
	}
}
`;

describe("Go categories beyond the server's tokens", () => {
  it("splits calls, types, packages, receivers and shadowed names", async () => {
    const text = Text.of(source.split("\n"));
    const support = await loadSupport(findLanguageDescription("Go", "demo.go")!);
    const tree = support!.language.parser.parse(source);
    const ranges = semanticRanges(text, { tokenTypes: [], tokenModifiers: [], data: [] }, false, "go", tree);
    const pairs = ranges.map((r) => `${text.sliceString(r.from, r.to)}:${r.className}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        "len:cm-sem-go-builtin",
        "string:cm-sem-go-builtin",
        "int:cm-sem-go-builtin",
        "helper:cm-sem-go-call-local",
        "Println:cm-sem-go-call-exported",
        "Count:cm-sem-go-call-exported",
        "fmt:cm-sem-go-package",
        "http:cm-sem-go-package",
        "Store:cm-sem-go-type",
        "s:cm-sem-go-receiver",
        "q:cm-sem-go-shadowing",
        "Search:cm-sem-go-comment-ref",
      ]),
    );
  });

  it("renders the categories in the editor", async () => {
    const support = await loadSupport(findLanguageDescription("Go", "demo.go")!);
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "package demo\n\nfunc helper(n int) int { return len(n) }\n\nfunc use() int { return helper(1) }\n",
        extensions: [support!, lspDoc.of({ doc: 1, language: "go" } as EditorDocContext), semanticExtension()],
      }),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const builtins = [...view.dom.querySelectorAll(".cm-sem-go-builtin")].map((node) => node.textContent);
      expect(builtins).toContain("len");
      expect([...view.dom.querySelectorAll(".cm-sem-go-call-local")].map((node) => node.textContent)).toEqual([
        "helper",
      ]);
      expect(view.dom.querySelector(".cm-sem-go-type")).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
