import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";

const { lspGoto, lspGotoImplementation } = vi.hoisted(() => ({
  lspGoto: vi.fn<typeof commands.lspGoto>(),
  lspGotoImplementation: vi.fn<typeof commands.lspGotoImplementation>(),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto, lspGotoImplementation } };
});

const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { closePopup } = await import("./popupStore");
const { provideEditorService } = await import("@/workbench/contributions");

const openFile = vi.fn(async (_path: string, _opts: unknown) => {});
provideEditorService({ openFile } as never);

const loc = (path: string): Location => ({
  path,
  uri: null,
  range: { start: { line: 1, col: 2 }, end: { line: 1, col: 5 } },
});
const ok = (data: Location[]) => ({ status: "ok" as const, data });
const declared = loc("/p/store.go");
const implementation = loc("/p/iface.go");

const TEXT = "package p\n\nfunc (s *Store) Search() {}\n";
let view: EditorView;

beforeEach(() => {
  // The implementation request streams its first results through a Tauri Channel.
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
  };
  lspGoto.mockReset().mockResolvedValue(ok([]));
  lspGotoImplementation.mockReset().mockResolvedValue(ok([]));
  openFile.mockClear();
  view = new EditorView({
    state: EditorState.create({
      doc: TEXT,
      extensions: [lspDoc.of({ doc: 1, path: "/p/store.go", language: "go", uiMode: "Go", readOnly: false })],
    }),
    parent: document.body,
  });
});
afterEach(() => {
  view.destroy();
  closePopup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Go to Implementation on `Search`, at the method's name. */
const gotoSearch = () => gotoTargets(view, "implementation", TEXT.indexOf("Search") + 2);

describe("Go to Implementation on a method nothing implements", () => {
  it("navigates to the declaration, like IDEA", async () => {
    lspGoto.mockResolvedValue(ok([declared]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/store.go"]);
  });

  it("shields the server's message and navigates when the request fails", async () => {
    lspGotoImplementation.mockRejectedValue(new Error("no interfaces implemented by this method"));
    lspGoto.mockResolvedValue(ok([implementation]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/iface.go"]);
  });

  it("still navigates to the implementations when there are some", async () => {
    lspGotoImplementation.mockResolvedValue(ok([implementation]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/iface.go"]);
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("says nothing implements the name instead of navigating onto the declaration itself", async () => {
    const at = TEXT.indexOf("Search");
    const col = at - (TEXT.lastIndexOf("\n", at) + 1);
    lspGoto.mockResolvedValue(
      ok([{ ...declared, range: { start: { line: 2, col }, end: { line: 2, col: col + 6 } } }]),
    );
    await gotoSearch();
    expect(openFile).not.toHaveBeenCalled();
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toContain("No implementations found");
  });
});
